import { beforeEach, describe, expect, it } from "vitest";
import { useSignatureStore } from "./signatures";
import type { SignatureVerification } from "../lib/types";

const good: SignatureVerification = { status: "Good", signer: "a@x", key_id: null, raw: null };

beforeEach(() => {
  useSignatureStore.setState({ byRepo: {} });
});

describe("signature store", () => {
  it("clearRepo drops only that repo's verdicts", () => {
    const s = useSignatureStore.getState();
    s.record("repo-a", "sha1", good);
    s.record("repo-a", "sha2", good);
    s.record("repo-b", "sha1", good);

    useSignatureStore.getState().clearRepo("repo-a");

    const byRepo = useSignatureStore.getState().byRepo;
    expect(byRepo["repo-a"]).toBeUndefined();
    expect(byRepo["repo-b"]?.["sha1"]).toEqual(good);
  });

  it("clearRepo on an unknown repo is a no-op", () => {
    useSignatureStore.getState().record("repo-a", "sha1", good);
    useSignatureStore.getState().clearRepo("repo-x");
    expect(useSignatureStore.getState().byRepo["repo-a"]?.["sha1"]).toEqual(good);
  });
});
