//! Tests for foreign asset markets.
//!
//! Foreign assets use the `0x0220` ERC20 precompile prefix and require an explicit
//! SCALE-encoded XCM Location in the TokenConfig at market creation time.
//!
//! | Test | What it does |
//! |------|-------------|
//! | t0   | Register a foreign asset on AH, create a market with xcmLocation, verify local settlement |

use super::*;

/// Foreign asset index used for testing (WETH-like token).
/// The pallet-assets-precompiles pallet assigns sequential indices starting from 0.
/// This is the first foreign asset created on AH, so it gets index 0.
const FOREIGN_ASSET_INDEX: u32 = 0;

/// Derive the ERC20 precompile address for a foreign asset.
/// Formula: `0x<assetIndex_be_4bytes>000000000000000000000000_0220_0000`
fn foreign_asset_id_to_erc20(index: u32) -> H160 {
    let mut addr = [0u8; 20];
    addr[..4].copy_from_slice(&index.to_be_bytes());
    addr[16] = 0x02;
    addr[17] = 0x20;
    H160::from(addr)
}

/// SCALE-encode an XCM Location for use in TokenConfig.xcmLocation.
///
/// This must match what `XcmBuilder.sol` expects — the raw SCALE bytes of a
/// `staging_xcm::Location` value.
fn scale_encode_location(location: &Location) -> Vec<u8> {
    codec::Encode::encode(location)
}

/// The XCM Location that identifies our test foreign asset on Asset Hub.
/// We use a simple Ethereum-style location:
///   Location { parents: 2, interior: X1(GlobalConsensus(Ethereum { chain_id: 1 })) }
///
/// This is the canonical representation for bridged Ethereum assets on Polkadot.
fn test_foreign_asset_location() -> Location {
    Location::new(
        2,
        [xcm::prelude::GlobalConsensus(
            xcm::prelude::NetworkId::Ethereum { chain_id: 1 },
        )],
    )
}

#[test]
fn foreign_asset_local_settlement() {
    // Reuse the standard setup (funds, accounts, contract deployment)
    let (pallet_state, alice, bob, dave, _charlie, _sov_2000) = setup_pallet_asset_market();

    let foreign_erc20 = foreign_asset_id_to_erc20(FOREIGN_ASSET_INDEX);
    let foreign_location = test_foreign_asset_location();
    let foreign_location_bytes = scale_encode_location(&foreign_location);

    eprintln!(
        "[foreign] Foreign asset ERC20: {:?}, location bytes: {} bytes",
        foreign_erc20,
        foreign_location_bytes.len()
    );

    // =====================================================================
    // Register the foreign asset on Asset Hub via ForeignAssets pallet
    // =====================================================================

    AssetHubWestend::execute_with(|| {
        type ForeignAssets = asset_hub_westend_runtime::ForeignAssets;
        type RuntimeOrigin = asset_hub_westend_runtime::RuntimeOrigin;

        // force_create the foreign asset (requires root/sudo)
        assert_ok!(ForeignAssets::force_create(
            RuntimeOrigin::root(),
            foreign_location.clone(),
            alice.clone().into(), // admin
            true,                 // is_sufficient
            1,                    // min_balance
        ));

        // Set metadata
        assert_ok!(ForeignAssets::set_metadata(
            RuntimeOrigin::signed(alice.clone()),
            foreign_location.clone(),
            b"tWETH".to_vec(),
            b"tWETH".to_vec(),
            18, // WETH uses 18 decimals
        ));

        // Mint to Alice and Bob
        assert_ok!(ForeignAssets::mint(
            RuntimeOrigin::signed(alice.clone()),
            foreign_location.clone(),
            alice.clone().into(),
            1_000_000_000_000_000_000_000, // 1000 tokens (18 dec)
        ));
        assert_ok!(ForeignAssets::mint(
            RuntimeOrigin::signed(alice.clone()),
            foreign_location.clone(),
            bob.clone().into(),
            500_000_000_000_000_000_000, // 500 tokens (18 dec)
        ));
        assert_ok!(ForeignAssets::mint(
            RuntimeOrigin::signed(alice.clone()),
            foreign_location.clone(),
            dave.clone().into(),
            500_000_000_000_000_000_000, // 500 tokens (18 dec)
        ));

        eprintln!("[foreign] Foreign asset registered and minted");
    });

    // =====================================================================
    // Create a foreign-asset market: tWETH (foreign) / tUSD (pallet)
    // =====================================================================

    // Foreign asset tick/size params.
    // Order sizes are in base-token units (18 decimals for tWETH).
    // Prices are in 18-decimal fixed-point: quoteCost = price * amount / 1e18.
    //
    // Example: 0.01 tWETH at price 3e12 => quoteCost = 3e12 * 1e16 / 1e18 = 30_000_000
    //          = 30 tUSD (6 dec). Affordable and sensible.
    let tick_size: u128 = 1_000_000_000_000; // 1e12 — suitable for 18-dec base / 6-dec quote
    let min_order_size: u128 = 1_000_000_000_000_000; // 0.001 tWETH (18 dec)
    let max_order_size: u128 = 1_000_000_000_000_000_000_000; // 1000 tWETH (18 dec)

    let foreign_market = AssetHubWestend::execute_with(|| {
        let quote_erc20 = pallet_state.quote_erc20;

        // Create market with foreign asset as base (xcmLocation populated)
        let create_data = encode_create_market(
            foreign_erc20,
            quote_erc20,
            foreign_location_bytes.clone(), // base has explicit XCM location
            vec![],                         // quote is pallet asset (derived on-chain)
            tick_size,
            min_order_size,
            max_order_size,
        );
        call_contract(alice.clone(), pallet_state.factory, 0, create_data);

        let market = query_get_market(pallet_state.factory, foreign_erc20, quote_erc20);
        assert_ne!(market, H160::zero(), "Foreign market should not be zero address");
        eprintln!("[foreign] Foreign market deployed at {:?}", market);

        // Approve the market for Bob (buyer — needs quote tokens) and Dave (seller — needs foreign tokens)
        let large_allowance: u128 = 1_000_000_000_000_000_000_000;
        call_contract(
            bob.clone(),
            quote_erc20,
            0,
            encode_approve(market, large_allowance),
        );
        call_contract(
            dave.clone(),
            foreign_erc20,
            0,
            encode_approve(market, large_allowance),
        );

        market
    });

    // =====================================================================
    // Local settlement: Bob BUY + Dave SELL at same price
    // =====================================================================

    // quoteCost = 3e12 * 1e16 / 1e18 = 30_000_000 = 30 tUSD (6 dec)
    let test_price: u128 = 3_000_000_000_000; // 3e12, tick-aligned (3e12 % 1e12 == 0)
    let test_amount: u128 = 10_000_000_000_000_000; // 0.01 tWETH (1e16)

    AssetHubWestend::execute_with(|| {
        eprintln!("[foreign] Testing local settlement...");

        let bob_h160 = account_to_h160(&bob);
        let dave_h160 = account_to_h160(&dave);

        // Check Bob's initial foreign token balance (should be 0 before match)
        let bob_foreign_before = query_balance_of(foreign_erc20, bob_h160);
        eprintln!("[foreign] Bob foreign balance before: {bob_foreign_before}");

        // Bob places BUY at $3,000 (local order)
        call_contract(
            bob.clone(),
            foreign_market,
            0,
            encode_place_limit_order(0, test_price, test_amount, [0u8; 32], [0u8; 32], 0, 0),
        );
        eprintln!("[foreign] Bob BUY placed");

        // Dave places SELL at $3,000 → should match
        call_contract(
            dave.clone(),
            foreign_market,
            0,
            encode_place_limit_order(1, test_price, test_amount, [0u8; 32], [0u8; 32], 0, 0),
        );
        eprintln!("[foreign] Dave SELL placed");

        // Bob should have received foreign tokens
        let bob_foreign_after = query_balance_of(foreign_erc20, bob_h160);
        assert!(
            bob_foreign_after > bob_foreign_before,
            "Bob should receive foreign tokens after match (before={bob_foreign_before}, after={bob_foreign_after})"
        );

        // Dave should have received quote tokens
        let dave_quote = query_balance_of(pallet_state.quote_erc20, dave_h160);
        assert!(
            dave_quote > 0,
            "Dave should receive quote tokens after match"
        );

        eprintln!(
            "[foreign] Local settlement OK! Bob foreign={}, Dave quote={}",
            bob_foreign_after, dave_quote
        );
    });

    eprintln!("═══════════════════════════════════════════════════════════════");
    eprintln!(" Foreign asset test passed!");
    eprintln!("═══════════════════════════════════════════════════════════════");
}
