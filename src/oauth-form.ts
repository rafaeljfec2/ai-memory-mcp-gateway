import { securityHeaders } from "./oauth-responses.js";

const maxFormLength = 4096;

type ConsentFormResult =
  | Readonly<{ kind: "valid"; form: URLSearchParams }>
  | Readonly<{ kind: "invalid"; response: Response }>;

export async function readConsentForm(request: Request): Promise<ConsentFormResult> {
  if (!isFormContentType(request.headers.get("content-type"))) {
    return invalidConsentForm("Expected an URL-encoded consent form", 415);
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(0|[1-9]\d*)$/.test(declaredLength) || !Number.isSafeInteger(Number(declaredLength))) {
      return invalidConsentForm("Invalid consent form length", 400);
    }
    if (Number(declaredLength) > maxFormLength) {
      return invalidConsentForm("Consent form is too large", 413);
    }
  }

  const body = await readBoundedBody(request);
  if (body === undefined) {
    return invalidConsentForm("Consent form is too large", 413);
  }

  return { kind: "valid", form: new URLSearchParams(body) };
}

function invalidConsentForm(message: string, status: number): ConsentFormResult {
  return {
    kind: "invalid",
    response: new Response(message, { status, headers: securityHeaders() }),
  };
}

async function readBoundedBody(request: Request): Promise<string | undefined> {
  if (request.body === null) {
    return "";
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value.byteLength > maxFormLength - totalBytes) {
      await cancelOversizedBody(reader);
      return undefined;
    }
    chunks.push(value);
    totalBytes += value.byteLength;
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

async function cancelOversizedBody(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel("OAuth consent form exceeds the size limit");
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.error("Could not cancel oversized OAuth request body", { errorName });
  }
}

function isFormContentType(contentType: string | null): boolean {
  return contentType?.toLowerCase().startsWith("application/x-www-form-urlencoded") ?? false;
}
