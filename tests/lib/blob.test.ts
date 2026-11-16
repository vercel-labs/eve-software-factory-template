import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The Blob document helpers, against a stand-in for `@vercel/blob`.
 *
 * @remarks
 * The store is provisioned private, and a store refuses a call made with
 * the other access. These tests pin the access each helper asks for, which
 * is the one thing about them the rest of the suite cannot see.
 */

const { get, put } = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));

vi.mock("@vercel/blob", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vercel/blob")>()),
  get,
  put,
}));

const { readDocument, writeDocument } = await import("#lib/blob.js");

beforeEach(() => {
  get.mockReset();
  put.mockReset();
});

describe("the Blob document helpers use private access", () => {
  test("a write is private, to the exact key, and never overwrites unless asked", async () => {
    put.mockResolvedValue({ pathname: "artifacts/memo-x-abc123.md" });
    await writeDocument("artifacts/memo-x-abc123.md", "# Memo\n", {
      allowOverwrite: false,
    });
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith("artifacts/memo-x-abc123.md", "# Memo\n", {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: "text/markdown",
    });
  });

  test("a read is private, and returns the document's text", async () => {
    get.mockResolvedValue({
      blob: { uploadedAt: new Date("2026-11-17T00:00:00.000Z") },
      stream: new Response("# Memo\n").body,
    });
    expect(await readDocument("artifacts/memo-x-abc123.md")).toEqual({
      content: "# Memo\n",
      found: true,
      uploadedAt: "2026-11-17T00:00:00.000Z",
    });
    expect(get).toHaveBeenCalledWith("artifacts/memo-x-abc123.md", {
      access: "private",
    });
  });

  test("a document that is not there reads as not found", async () => {
    get.mockResolvedValue(null);
    expect(await readDocument("artifacts/none.md")).toEqual({ found: false });
    expect(get).toHaveBeenCalledWith("artifacts/none.md", {
      access: "private",
    });
  });
});
