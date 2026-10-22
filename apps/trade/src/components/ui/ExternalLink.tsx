// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { openExternal } from "../../lib/host/navigate";

type ExternalLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "target" | "rel" | "href"> & { href: string };

/**
 * A link that opens outside the app: through the host inside a Polkadot host, in a new tab elsewhere.
 * It stays a real link, so it can still be copied or long-pressed.
 */
export function ExternalLink({ href, onClick, children, ...rest }: ExternalLinkProps) {
  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (!e.defaultPrevented && openExternal(href)) e.preventDefault();
  };
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
