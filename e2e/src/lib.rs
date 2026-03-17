//! Emulated XCM integration tests for substrade-hub.
//!
//! Uses polkadot-sdk's `xcm-emulator` to run the full Westend relay + Asset Hub +
//! PenpalA network in-process. Local contract calls use `bare_instantiate` / `bare_call`;
//! cross-chain orders use real XCM Transact from PenpalA over HRMP.

#[cfg(test)]
mod tests;
