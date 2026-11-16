// Call after signing in once as the bot; keep every other profile field.
import type { AtpAgent } from "@atproto/api";

const errorCode = (error: unknown) =>
  error && typeof error === "object" && "error" in error ? error.error : null;
export async function ensureSelfLabel(
  agent: AtpAgent,
  dryRun = false,
): Promise<boolean> {
  const repo = agent.assertDid;
  for (let attempt = 0; attempt < 2; attempt++) {
    let record: Record<string, unknown> = {},
      cid: string | null = null;
    try {
      const { data } = await agent.com.atproto.repo.getRecord({
        repo,
        collection: "app.bsky.actor.profile",
        rkey: "self",
      });
      if (
        !data.value ||
        typeof data.value !== "object" ||
        Array.isArray(data.value)
      )
        throw new Error("Invalid profile");
      record = structuredClone(data.value as Record<string, unknown>);
      cid = data.cid ?? null;
    } catch (error) {
      if (errorCode(error) !== "RecordNotFound") throw error;
    }
    const labels = record.labels as
      | { $type?: string; values?: { val: string }[] }
      | undefined;
    if (
      labels &&
      (labels.$type !== "com.atproto.label.defs#selfLabels" ||
        !Array.isArray(labels.values) ||
        !labels.values.every((value) => value && typeof value.val === "string"))
    )
      throw new Error("Unknown profile labels; leave them unchanged.");
    const values = labels?.values ?? [];
    if (values.some((value) => value.val === "bot")) return false;
    if (values.length >= 10)
      throw new Error("The profile already has ten self-labels.");
    if (dryRun) return true;
    try {
      await agent.com.atproto.repo.putRecord({
        repo,
        collection: "app.bsky.actor.profile",
        rkey: "self",
        swapRecord: cid,
        record: {
          ...record,
          $type: "app.bsky.actor.profile",
          labels: {
            ...labels,
            $type: "com.atproto.label.defs#selfLabels",
            values: [...values, { val: "bot" }],
          },
        },
      });
      return true;
    } catch (error) {
      // Re-read once on a concurrent profile edit; never overwrite blindly.
      if (errorCode(error) !== "InvalidSwap" || attempt === 1) throw error;
    }
  }
  return false;
}
