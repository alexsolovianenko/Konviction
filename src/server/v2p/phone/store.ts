import { BlobPreconditionFailedError, get, put } from "@vercel/blob";

export async function read<T>(path: string): Promise<T | null> {
  const blob = await get("phone/v1/" + path + ".json", { access: "private", useCache: false });
  if (!blob) return null;
  if (blob.statusCode !== 200) throw Error("Phone storage unavailable");
  return new Response(blob.stream).json();
}

export async function claim(path: string, value: unknown): Promise<boolean> {
  try {
    await put("phone/v1/" + path + ".json", JSON.stringify(value), {
      access: "private",
      allowOverwrite: false,
      addRandomSuffix: false,
      contentType: "application/json",
    });
    return true;
  } catch (e) {
    if (e instanceof BlobPreconditionFailedError || /already exists/i.test(String(e))) return false;
    throw e;
  }
}
