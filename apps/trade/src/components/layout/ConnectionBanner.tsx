import { useHostConnectionStore } from "../../stores/host-connection";

/** A strip under the header while the host channel is down. Renders nothing while it is up. */
export function ConnectionBanner() {
  const connection = useHostConnectionStore((s) => s.connection);
  if (connection === "ok") return null;
  return (
    <div role="status" className="border-b border-sell/40 bg-sell-dim px-4 py-2 text-center text-sm text-text-primary">
      {connection === "reconnecting"
        ? "Reconnecting to the host… Orders and cancels cannot be sent until the connection is back."
        : "The connection to the host is lost. Orders and cancels cannot be sent until it is back."}
    </div>
  );
}
