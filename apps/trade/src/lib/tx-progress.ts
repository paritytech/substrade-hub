/**
 * The steps of a submitted transaction, as the UI reports them: signed by the wallet, submitted to the
 * network, included in a block, then finalized.
 */
export type TxStep = "signed" | "submitted" | "in-block" | "finalized";
