import { describe, expect, it } from "vitest";
import { hashMatches, parseRoute, resolveMarket, routeHash } from "./route";

const A = "0x00000000000000000000000000000000000000aA" as const;
const B = "0x00000000000000000000000000000000000000bb" as const;

describe("parseRoute", () => {
  it("reads Home, a market and the orders panel", () => {
    expect(parseRoute("")).toEqual({ view: "home" });
    expect(parseRoute("#/")).toEqual({ view: "home" });
    expect(parseRoute(`#/market/${A}`)).toEqual({ view: "trade", market: A });
    expect(parseRoute(`#/market/${A}/`)).toEqual({ view: "trade", market: A });
    expect(parseRoute("#/orders")).toEqual({ view: "trade", focus: "orders" });
  });

  it("marks a market link that is not a full address", () => {
    expect(parseRoute("#/market/0x1234")).toEqual({ view: "trade", brokenLink: true });
    expect(parseRoute("#/market/")).toEqual({ view: "trade", brokenLink: true });
    expect(hashMatches("#/market/0x1234", "trade", A)).toBe(false);
  });

  it("treats anything else as Home", () => {
    expect(parseRoute("#/elsewhere")).toEqual({ view: "home" });
    expect(parseRoute("#section")).toEqual({ view: "home" });
  });
});

describe("routeHash and hashMatches", () => {
  it("writes Home and a market, and nothing for Trade without one", () => {
    expect(routeHash("home", undefined)).toBe("#/");
    expect(routeHash("trade", A)).toBe(`#/market/${A}`);
    expect(routeHash("trade", undefined)).toBeNull();
  });

  it("matches a hash naming the same state, whatever the address case", () => {
    expect(hashMatches("", "home", A)).toBe(true);
    expect(hashMatches(`#/market/${A.toLowerCase()}`, "trade", A)).toBe(true);
    expect(hashMatches(`#/market/${A}`, "trade", B)).toBe(false);
    expect(hashMatches("#/orders", "trade", A)).toBe(false);
    expect(hashMatches("#/", "trade", A)).toBe(false);
  });
});

describe("resolveMarket", () => {
  const markets = [{ address: A }, { address: B }];

  it("selects the linked market", () => {
    expect(resolveMarket({ view: "trade", market: B.toUpperCase().replace("0X", "0x") as `0x${string}` }, markets, null)).toEqual({
      market: markets[1],
      notListed: false,
    });
  });

  it("keeps the selection, or takes the first market, when the route names none", () => {
    expect(resolveMarket({ view: "home" }, markets, null)).toEqual({ market: markets[0], notListed: false });
    expect(resolveMarket({ view: "trade", focus: "orders" }, markets, markets[1]!)).toEqual({ market: markets[1], notListed: false });
  });

  it("flags a linked market this network does not list", () => {
    const other = "0x00000000000000000000000000000000000000cc" as const;
    expect(resolveMarket({ view: "trade", market: other }, markets, null)).toEqual({ market: markets[0], notListed: true });
  });
});
