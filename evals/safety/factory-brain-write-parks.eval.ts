import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Writing to the shared factory brain from an untrusted session parks on an approval card with the write itself pending; the eval principal is untrusted, so this is also what the dev TUI shows. The brain is recalled into every turn without a tool call, so this gates the write, not the read.",
  tags: ["fast", "needs-connect"],
  async test(t) {
    const turn = await t.send(
      "Record a durable note in the factory brain: this repo's test suite must be run with `pnpm test --runInBand`, or it flakes. Save it to the brain now."
    );
    t.awaitingInput();
    turn.session.requireInteraction({ toolName: "brain__save_memory" });
    t.calledTool("brain__save_memory", { status: "pending" });
  },
});
