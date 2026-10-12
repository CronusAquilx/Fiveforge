import { spawn } from "node:child_process";
import express, { Router, type IRouter, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const router: IRouter = Router();
const directory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(directory, "../../..");
const pythonScript = path.resolve(directory, "native_assets.py");
const MAX_FILE_BYTES = 250 * 1024 * 1024;
const MAX_PROCESS_OUTPUT = 350 * 1024 * 1024;

router.use(express.json({ limit: "360mb" }));

function base64WithinLimit(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= Math.ceil(MAX_FILE_BYTES * 4 / 3) + 16;
}

function runProcessor(operation: string, payload: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn("uv", ["run", "--project", workspaceRoot, "python", pythonScript, operation], {
      cwd: workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(error);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_PROCESS_OUTPUT) {
        fail(new Error("The decoded asset is too large to return safely."));
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 6000) stderr += chunk;
    });
    child.on("error", (error) => fail(new Error(`Could not start the native asset reader: ${error.message}`)));
    child.stdin.on("error", () => undefined);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      let result: Record<string, unknown>;
      try {
        result = JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        reject(new Error(stderr.trim() || "The native asset reader returned an invalid response."));
        return;
      }
      if (code !== 0 || typeof result.error === "string") {
        reject(new Error(typeof result.error === "string" ? result.error : stderr.trim() || "The native asset could not be read."));
        return;
      }
      resolve(result);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function runBinaryProcessor(operation: string, payload: Buffer): Promise<{ metadata: Record<string, unknown>; model: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn("uv", ["run", "--project", workspaceRoot, "python", pythonScript, operation], {
      cwd: workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(error);
    };
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > MAX_PROCESS_OUTPUT) {
        fail(new Error("The decoded asset is too large to return safely."));
        return;
      }
      stdout.push(buffer);
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 6000) stderr += chunk;
    });
    child.on("error", (error) => fail(new Error(`Could not start the native asset reader: ${error.message}`)));
    child.stdin.on("error", () => undefined);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      const output = Buffer.concat(stdout);
      if (code !== 0) {
        let result: Record<string, unknown>;
        try {
          result = JSON.parse(output.toString("utf8")) as Record<string, unknown>;
        } catch {
          reject(new Error(stderr.trim() || "The native asset reader returned an invalid response."));
          return;
        }
        reject(new Error(typeof result.error === "string" ? result.error : stderr.trim() || "The native asset could not be read."));
        return;
      }
      if (output.length < 5) {
        reject(new Error("The native asset reader returned an incomplete binary model."));
        return;
      }
      const metadataLength = output.readUInt32BE(0);
      if (metadataLength < 2 || metadataLength > 1024 * 1024 || 4 + metadataLength >= output.length) {
        reject(new Error("The native asset reader returned invalid preview metadata."));
        return;
      }
      try {
        const metadata = JSON.parse(output.subarray(4, 4 + metadataLength).toString("utf8")) as Record<string, unknown>;
        resolve({ metadata, model: output.subarray(4 + metadataLength) });
      } catch {
        reject(new Error("The native asset reader returned invalid preview metadata."));
      }
    });
    child.stdin.end(payload);
  });
}

function sendError(response: Response, error: unknown) {
  const message = error instanceof Error ? error.message : "The native asset could not be processed.";
  response.status(message.includes("larger than") || message.includes("exceed") || message.includes("oversized") ? 413 : 422).json({ error: message });
}

router.post("/decode-ytd", async (request: Request, response: Response) => {
  const body = request.body as { fileName?: unknown; dataBase64?: unknown } | undefined;
  if (!body || !base64WithinLimit(body.dataBase64)) {
    response.status(400).json({ error: "Choose a valid YTD file smaller than 250 MB." });
    return;
  }
  try {
    response.json(await runProcessor("decode-ytd", body));
  } catch (error) {
    sendError(response, error);
  }
});

router.post("/replace-ytd", async (request: Request, response: Response) => {
  const body = request.body as { fileName?: unknown; dataBase64?: unknown; textureName?: unknown; imageBase64?: unknown } | undefined;
  if (!body || !base64WithinLimit(body.dataBase64) || !base64WithinLimit(body.imageBase64) || typeof body.textureName !== "string") {
    response.status(400).json({ error: "The YTD file, replacement image, or selected texture is invalid." });
    return;
  }
  try {
    response.json(await runProcessor("replace-ytd", body));
  } catch (error) {
    sendError(response, error);
  }
});

router.post("/preview-yft", async (request: Request, response: Response) => {
  const body = request.body as { modelBase64?: unknown; textureDictionaries?: unknown } | undefined;
  if (!body || !base64WithinLimit(body.modelBase64) || !Array.isArray(body.textureDictionaries) || body.textureDictionaries.length > 24) {
    response.status(400).json({ error: "Choose a valid YFT and up to 24 matching YTD files." });
    return;
  }
  const totalEncoded = body.textureDictionaries.reduce((total: number, item: unknown) => {
    if (!item || typeof item !== "object" || !("dataBase64" in item) || typeof item.dataBase64 !== "string") return total;
    return total + item.dataBase64.length;
  }, body.modelBase64.length);
  if (totalEncoded > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 16) {
    response.status(413).json({ error: "The YFT and its texture dictionaries exceed the 250 MB preview limit." });
    return;
  }
  try {
    response.json(await runProcessor("preview-yft", body));
  } catch (error) {
    sendError(response, error);
  }
});

router.post("/preview-yft-binary", express.raw({ type: "application/octet-stream", limit: "360mb" }), async (request: Request, response: Response) => {
  if (!Buffer.isBuffer(request.body) || request.body.length < 6) {
    response.status(400).json({ error: "Choose a valid YFT and up to 24 matching YTD files." });
    return;
  }
  try {
    const result = await runBinaryProcessor("preview-yft-binary", request.body);
    response.setHeader("Content-Type", "model/gltf-binary");
    response.setHeader("X-Forge-Preview-Metadata", Buffer.from(JSON.stringify(result.metadata), "utf8").toString("base64"));
    response.send(result.model);
  } catch (error) {
    sendError(response, error);
  }
});

export default router;
