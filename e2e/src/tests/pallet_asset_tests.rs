//! Tests for trust-backed pallet asset markets (tGOLD/tUSD).
//!
//! | Test | What it does |
//! |------|-------------|
//! | t0   | Setup verification: assets exist, accounts funded, contracts deployed |
//! | t1   | Local settlement: BUY + SELL at same price → match → ERC20 transfer |
//! | t2   | Cross-chain order: PenpalA → AH via XCM Transact → order rests on book |
//! | t3   | Cross-chain settlement: match → base tokens delivered to PenpalA via XCM |
//! | t4   | Cross-chain cancel: cancel resting order → refund PendingClaim created |

use super::*;

#[test]
fn full_dlob_lifecycle() {
    let (state, alice, bob, dave, charlie, sov_2000) = setup_pallet_asset_market();

    // =====================================================================
    // T0: Setup verification
    // =====================================================================

    AssetHubWestend::execute_with(|| {
        eprintln!("[t0] Verifying setup...");

        let alice_quote =
            <asset_hub_westend_runtime::Assets as frame_support::traits::fungibles::Inspect<
                _,
            >>::balance(QUOTE_ASSET_ID, &alice);
        assert!(alice_quote > 0, "Alice should hold quote tokens");

        let alice_base =
            <asset_hub_westend_runtime::Assets as frame_support::traits::fungibles::Inspect<
                _,
            >>::balance(BASE_ASSET_ID, &alice);
        assert!(alice_base > 0, "Alice should hold base tokens");

        let bob_native =
            <asset_hub_westend_runtime::Balances as frame_support::traits::fungible::Inspect<
                _,
            >>::balance(&bob);
        assert!(bob_native > 0, "Bob should have native balance");

        let next_id = query_next_order_id(state.market);
        assert!(next_id >= 1, "Market should have initial nextOrderId >= 1");

        eprintln!("[t0] Setup verification passed");
    });

    // =====================================================================
    // T1: Local settlement — Bob (BUY) + Dave (SELL) at same price
    // =====================================================================

    AssetHubWestend::execute_with(|| {
        eprintln!("[t1] Local settlement test...");

        let bob_h160 = account_to_h160(&bob);
        let dave_h160 = account_to_h160(&dave);

        // Bob places BUY at $5,000
        call_contract(
            bob.clone(),
            state.market,
            0,
            encode_place_limit_order(0, PRICE_HIGH, AMOUNT_10, [0u8; 32], [0u8; 32], 0, 0),
        );
        eprintln!("[t1] Bob BUY placed");

        // Dave places SELL at $5,000 → crosses spread → should match
        call_contract(
            dave.clone(),
            state.market,
            0,
            encode_place_limit_order(1, PRICE_HIGH, AMOUNT_10, [0u8; 32], [0u8; 32], 0, 0),
        );
        eprintln!("[t1] Dave SELL placed");

        let bob_base = query_balance_of(state.base_erc20, bob_h160);
        assert!(bob_base > 0, "Bob should have base tokens after match");

        let dave_quote = query_balance_of(state.quote_erc20, dave_h160);
        assert!(dave_quote > 0, "Dave should have quote tokens after match");

        eprintln!(
            "[t1] Local settlement OK! Bob base={}, Dave quote={}",
            bob_base, dave_quote
        );
    });

    // =====================================================================
    // T2: Cross-chain order from PenpalA (para 2000) → AH via XCM Transact
    // =====================================================================

    let id_before = AssetHubWestend::execute_with(|| query_next_order_id(state.market));

    let large_allowance: u128 = 1_000_000_000_000;

    // Step 1: ERC-20 approve via XCM Transact
    eprintln!("[t2] XCM Transact #1: approve quote token...");
    send_xcm_transact_revive(
        &sov_2000,
        &ReviveCall {
            dest: state.quote_erc20,
            value: 0,
            data: encode_approve(state.market, large_allowance),
        },
    );

    // Step 2: Place cross-chain BUY order via XCM Transact
    eprintln!("[t2] XCM Transact #2: placeLimitOrder...");
    send_xcm_transact_revive(
        &sov_2000,
        &ReviveCall {
            dest: state.market,
            value: 10 * DOT,
            data: encode_place_limit_order(
                0,
                PRICE_LOW,
                AMOUNT_5,
                charlie.clone().into(),
                charlie.clone().into(),
                2000,
                0,
            ),
        },
    );

    AssetHubWestend::execute_with(|| {
        let id_after = query_next_order_id(state.market);
        eprintln!("[t2] nextOrderId: before={id_before}, after={id_after}");
        assert!(
            id_after > id_before,
            "Cross-chain order should increment nextOrderId (before={id_before}, after={id_after})"
        );

        let bid = query_best_bid(state.market);
        assert_eq!(
            bid, PRICE_LOW,
            "Best bid should be the cross-chain order price"
        );

        eprintln!("[t2] Cross-chain order placed via XCM Transact");
    });

    // =====================================================================
    // T3: Cross-chain settlement — match → base tokens to PenpalA
    // =====================================================================

    eprintln!("[t3] XCM Transact: placeLimitOrder from PenpalA...");
    send_xcm_transact_revive(
        &sov_2000,
        &ReviveCall {
            dest: state.market,
            value: 10 * DOT,
            data: encode_place_limit_order(
                0,
                PRICE_LOW,
                AMOUNT_5,
                charlie.clone().into(),
                charlie.clone().into(),
                2000,
                0,
            ),
        },
    );
    eprintln!("[t3] Cross-chain BUY placed via XCM Transact");

    // Dave places local SELL at $4,990 → matches the cross-chain BUY
    AssetHubWestend::execute_with(|| {
        eprintln!("[t3] Dave placing SELL at $4,990...");
        call_contract(
            dave.clone(),
            state.market,
            0,
            encode_place_limit_order(1, PRICE_LOW, AMOUNT_5, [0u8; 32], [0u8; 32], 0, 0),
        );
        eprintln!("[t3] Dave SELL placed — should match cross-chain BUY");
    });

    // Verify sovereign quote balance decreased
    AssetHubWestend::execute_with(|| {
        let sov_quote =
            <asset_hub_westend_runtime::Assets as frame_support::traits::fungibles::Inspect<
                _,
            >>::balance(QUOTE_ASSET_ID, &sov_2000);
        eprintln!("[t3] Sovereign quote balance after settlement: {sov_quote}");
        assert!(
            sov_quote < 100_000_000_000,
            "Sovereign quote balance should decrease after order placement"
        );
    });

    // Verify base tokens arrived on PenpalA for Charlie
    PenpalA::execute_with(|| {
        type ForeignAssets = <PenpalA as PenpalAPallet>::ForeignAssets;
        let base_on_penpal = Location::new(
            1,
            [
                ParachainJunction(1000),
                PalletInstance(50),
                GeneralIndex(BASE_ASSET_ID as u128),
            ],
        );
        let charlie_base =
            <ForeignAssets as frame_support::traits::fungibles::Inspect<_>>::balance(
                base_on_penpal.clone(),
                &charlie,
            );
        eprintln!("[t3] Charlie's tGOLD on PenpalA: {charlie_base}");
        assert!(
            charlie_base > 0,
            "Charlie should receive base tokens on PenpalA after cross-chain settlement"
        );
        eprintln!("[t3] Cross-chain settlement happy path verified!");
    });

    // =====================================================================
    // T4: Cross-chain cancel — cancel resting order → refund PendingClaim
    // =====================================================================

    let far_price: u128 = 100_000_000_000_000_000_000; // $100

    eprintln!("[t4] XCM Transact: placeLimitOrder at $100...");
    send_xcm_transact_revive(
        &sov_2000,
        &ReviveCall {
            dest: state.market,
            value: 10 * DOT,
            data: encode_place_limit_order(
                0,
                far_price,
                AMOUNT_5,
                charlie.clone().into(),
                charlie.clone().into(),
                2000,
                0,
            ),
        },
    );

    let (order_id, claim_id_before) = AssetHubWestend::execute_with(|| {
        let next = query_next_order_id(state.market);
        let claim = query_next_claim_id(state.market);
        eprintln!("[t4] Order placed via XCM: nextOrderId={next}, nextClaimId={claim}");
        (next - 1, claim)
    });

    eprintln!("[t4] XCM Transact: cancelOrder({order_id})...");
    send_xcm_transact_revive(
        &sov_2000,
        &ReviveCall {
            dest: state.market,
            value: 0,
            data: encode_cancel_order(order_id, charlie.clone().into()),
        },
    );

    AssetHubWestend::execute_with(|| {
        let claim_id_after = query_next_claim_id(state.market);
        eprintln!("[t4] nextClaimId: before={claim_id_before}, after={claim_id_after}");
        assert!(
            claim_id_after > claim_id_before,
            "Cancel should create a refund PendingClaim (before={claim_id_before}, after={claim_id_after})"
        );
        eprintln!("[t4] Cancel + refund verified");
    });

    eprintln!("═══════════════════════════════════════════════════════════════");
    eprintln!(" All pallet-asset scenarios passed!");
    eprintln!("═══════════════════════════════════════════════════════════════");
}

// =========================================================================
// Standalone smoke tests
// =========================================================================

/// Verify basic HRMP message delivery from PenpalA to AssetHubWestend.
#[test]
fn hrmp_message_from_penpal_to_asset_hub_works() {
    let penpal_sovereign_on_ah = AssetHubWestend::sovereign_account_id_of(
        AssetHubWestend::sibling_location_of(PenpalA::para_id()),
    );
    AssetHubWestend::fund_accounts(vec![(
        penpal_sovereign_on_ah.clone(),
        ASSET_HUB_WESTEND_ED * 100_000,
    )]);

    let balance_before = AssetHubWestend::execute_with(|| {
        <asset_hub_westend_runtime::Balances as frame_support::traits::fungible::Inspect<_>>::balance(
            &penpal_sovereign_on_ah,
        )
    });

    let fee_amount = ASSET_HUB_WESTEND_ED * 1_000;
    let xcm = VersionedXcm::V5(Xcm::<()>(vec![
        WithdrawAsset(
            Asset {
                id: AssetId(Location::parent()),
                fun: Fungible(fee_amount),
            }
            .into(),
        ),
        xcm::prelude::BuyExecution {
            fees: Asset {
                id: AssetId(Location::parent()),
                fun: Fungible(fee_amount),
            },
            weight_limit: Unlimited,
        },
        RefundSurplus,
        xcm::prelude::DepositAsset {
            assets: Wild(xcm::prelude::All),
            beneficiary: Location::new(
                0,
                [AccountId32Junction {
                    network: None,
                    id: penpal_sovereign_on_ah.clone().into(),
                }],
            ),
        },
    ]));

    let dest: VersionedLocation =
        PenpalA::sibling_location_of(AssetHubWestend::para_id()).into();

    PenpalA::execute_with(|| {
        assert_ok!(<PenpalA as PenpalAPallet>::PolkadotXcm::send(
            <PenpalA as Chain>::RuntimeOrigin::root(),
            bx!(dest),
            bx!(xcm),
        ));
        PenpalA::assert_xcm_pallet_sent();
    });

    AssetHubWestend::execute_with(|| {
        AssetHubWestend::assert_xcmp_queue_success(None);
    });

    let balance_after = AssetHubWestend::execute_with(|| {
        <asset_hub_westend_runtime::Balances as frame_support::traits::fungible::Inspect<_>>::balance(
            &penpal_sovereign_on_ah,
        )
    });

    assert!(
        balance_after < balance_before,
        "Sovereign balance should decrease (fee consumed): before={balance_before}, after={balance_after}"
    );
}

/// Verify XCM with Transact calling pallet_revive::call works end-to-end.
#[test]
fn xcm_transact_revive_call_on_asset_hub() {
    let penpal_sovereign_on_ah = AssetHubWestend::sovereign_account_id_of(
        AssetHubWestend::sibling_location_of(PenpalA::para_id()),
    );

    AssetHubWestend::fund_accounts(vec![(
        penpal_sovereign_on_ah.clone(),
        ASSET_HUB_WESTEND_ED * 1_000_000,
    )]);

    let dummy_dest = H160::from([0x01u8; 20]);
    let revive_call = asset_hub_westend_runtime::RuntimeCall::Revive(pallet_revive::Call::<
        AHRuntime,
    >::call {
        dest: dummy_dest,
        value: 0u128,
        weight_limit: Weight::from_parts(500_000_000, 100_000),
        storage_deposit_limit: 0u128,
        data: vec![],
    });

    let fee_amount = ASSET_HUB_WESTEND_ED * 100_000;
    let xcm = VersionedXcm::V5(Xcm::<()>(vec![
        WithdrawAsset(
            Asset {
                id: AssetId(Location::parent()),
                fun: Fungible(fee_amount),
            }
            .into(),
        ),
        xcm::prelude::BuyExecution {
            fees: Asset {
                id: AssetId(Location::parent()),
                fun: Fungible(fee_amount),
            },
            weight_limit: Unlimited,
        },
        Transact {
            origin_kind: OriginKind::SovereignAccount,
            call: revive_call.encode().into(),
            fallback_max_weight: Some(Weight::from_parts(1_000_000_000, 200_000)),
        },
        RefundSurplus,
        xcm::prelude::DepositAsset {
            assets: Wild(xcm::prelude::All),
            beneficiary: Location::new(
                0,
                [AccountId32Junction {
                    network: None,
                    id: penpal_sovereign_on_ah.clone().into(),
                }],
            ),
        },
    ]));

    let dest: VersionedLocation =
        PenpalA::sibling_location_of(AssetHubWestend::para_id()).into();

    PenpalA::execute_with(|| {
        assert_ok!(<PenpalA as PenpalAPallet>::PolkadotXcm::send(
            <PenpalA as Chain>::RuntimeOrigin::root(),
            bx!(dest),
            bx!(xcm),
        ));
        PenpalA::assert_xcm_pallet_sent();
    });

    AssetHubWestend::execute_with(|| {
        type RuntimeEvent = <AssetHubWestend as Chain>::RuntimeEvent;
        assert_expected_events!(
            AssetHubWestend,
            vec![
                RuntimeEvent::Balances(pallet_balances::Event::Withdraw { who, .. }) => {
                    who: *who == penpal_sovereign_on_ah,
                },
            ]
        );
    });
}
