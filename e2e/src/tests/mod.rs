//! Shared imports, constants, helpers, and test infrastructure.

mod foreign_asset_tests;
mod pallet_asset_tests;

use codec::Encode;
use frame_support::{assert_ok, pallet_prelude::Weight};
use sp_core::{Pair as _, H160};
use xcm::prelude::{
    AccountId32 as AccountId32Junction, Asset, AssetId, Fungible, GeneralIndex, Location,
    OriginKind, PalletInstance, Parachain as ParachainJunction, RefundSurplus, Transact, Unlimited,
    VersionedLocation, VersionedXcm, Wild, WithdrawAsset, Xcm,
};

use emulated_integration_tests_common::xcm_emulator::{
    assert_expected_events, bx, Chain, Parachain as Para, TestExt,
};

use westend_system_emulated_network::{
    asset_hub_westend_emulated_chain::{
        asset_hub_westend_runtime, genesis::ED as ASSET_HUB_WESTEND_ED,
    },
    penpal_emulated_chain::PenpalAParaPallet as PenpalAPallet,
    AssetHubWestendPara as AssetHubWestend, AssetHubWestendParaSender as AssetHubWestendSender,
    PenpalAPara as PenpalA,
};

use parachains_common::AccountId;

// ABI encoding via alloy
use alloy_primitives::{Address as AlAddress, FixedBytes, Uint, U256 as AlU256};
use alloy_sol_types::{sol, SolCall, SolValue};

// =========================================================================
// Constants
// =========================================================================

/// 1 DOT = 10^12 Planck
const DOT: u128 = 1_000_000_000_000;

/// DLOB tick size: 0.001 in 18-decimal fixed-point
const TICK_SIZE: u128 = 1_000_000_000_000_000;

/// Minimum order size: 0.001 token at 6 decimals
const MIN_ORDER_SIZE: u128 = 1_000;

/// Maximum order size: 1000 tokens at 6 decimals
const MAX_ORDER_SIZE: u128 = 1_000_000_000;

/// Test prices in 18-decimal fixed-point (USD per oz gold)
const PRICE_HIGH: u128 = 5_000_000_000_000_000_000_000; // $5,000
const PRICE_LOW: u128 = 4_990_000_000_000_000_000_000; // $4,990

/// Test amounts (6-decimal token units)
const AMOUNT_10: u128 = 10_000_000;
const AMOUNT_5: u128 = 5_000_000;

/// Pallet-revive precompile addresses (fixed on Asset Hub)
const XCM_PRECOMPILE: [u8; 20] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x0A, 0, 0,
];
const SYSTEM_PRECOMPILE: [u8; 20] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x09, 0,
];

/// Asset IDs for test tokens (trust-backed pallet assets)
const QUOTE_ASSET_ID: u32 = 100; // tUSD (test USD stablecoin)
const BASE_ASSET_ID: u32 = 101; // tGOLD (test tokenized gold)

// =========================================================================
// ABI definitions
// =========================================================================

sol! {
    // ERC20 precompile interface
    function balanceOf(address owner) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);

    // Shared types
    struct TokenConfig {
        address token;
        bytes xcmLocation;
    }

    // DLOBFactory
    function createMarket(
        TokenConfig base, TokenConfig quote,
        uint96 tickSize, uint96 minOrderSize, uint128 maxOrderSize
    ) external payable returns (address);
    function getMarket(address base, address quote) external view returns (address);
    function setMinCrossChainFee(uint128 feeInPlanck) external;

    // DLOB
    function placeLimitOrder(
        uint8 side, uint96 price, uint128 amount,
        bytes32 originAccount, bytes32 settlementAccount,
        uint32 destParaId, uint64 expireTimestamp
    ) external payable returns (uint32);
    function cancelOrder(uint32 orderId, bytes32 originAccount) external;
    function bestBid() external view returns (uint96);
    function bestAsk() external view returns (uint96);
    function nextOrderId() external view returns (uint32);
    function nextClaimId() external view returns (uint32);
}

// =========================================================================
// Type aliases for readability
// =========================================================================

type AHRuntime = asset_hub_westend_runtime::Runtime;

// =========================================================================
// Helper: derive ERC20 precompile address from pallet-assets ID
// =========================================================================

/// Formula: `0x<assetId_be_4bytes>00000000000000000000000001200000`
fn asset_id_to_erc20(asset_id: u32) -> H160 {
    let mut addr = [0u8; 20];
    addr[..4].copy_from_slice(&asset_id.to_be_bytes());
    addr[16] = 0x01;
    addr[17] = 0x20;
    H160::from(addr)
}

/// Convert H160 to alloy Address for ABI encoding.
fn to_alloy_addr(h: H160) -> AlAddress {
    AlAddress::from(h.0)
}

// =========================================================================
// Helper: Forge artifact reading + library linking
// =========================================================================

/// Read init bytecode from a Forge JSON artifact.
/// Unlinked library placeholders (`__$...$__`) are zeroed; use `link_bytecode` after.
fn read_bytecode(artifact_path: &str) -> Vec<u8> {
    let base = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let full_path = base.join(artifact_path);
    let json: serde_json::Value = serde_json::from_reader(std::io::BufReader::new(
        std::fs::File::open(&full_path)
            .unwrap_or_else(|e| panic!("Failed to open {}: {e}", full_path.display())),
    ))
    .expect("Failed to parse artifact JSON");

    let hex_str = json["bytecode"]["object"]
        .as_str()
        .expect("missing bytecode.object in artifact");
    let hex_str = hex_str.strip_prefix("0x").unwrap_or(hex_str);

    // Zero out unlinked library placeholders (`__$<34 hex>$__` = 40 chars → 20 bytes)
    let mut s = hex_str.to_string();
    while let Some(start) = s.find("__$") {
        let end = s[start + 3..].find("$__").map(|i| start + 3 + i + 3);
        match end {
            Some(end) => s.replace_range(start..end, &"0".repeat(end - start)),
            None => break,
        }
    }
    hex::decode(&s).expect("Failed to decode hex bytecode")
}

/// Read link references from a Forge JSON artifact.
fn read_link_references(artifact_path: &str) -> Vec<(String, usize, usize)> {
    let base = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let json: serde_json::Value = serde_json::from_reader(std::io::BufReader::new(
        std::fs::File::open(base.join(artifact_path)).unwrap(),
    ))
    .unwrap();

    let mut refs = Vec::new();
    if let Some(link_refs) = json["bytecode"]["linkReferences"].as_object() {
        for (_file, libs) in link_refs {
            if let Some(libs) = libs.as_object() {
                for (lib_name, locations) in libs {
                    if let Some(locations) = locations.as_array() {
                        for loc in locations {
                            let start = loc["start"].as_u64().unwrap_or(0) as usize;
                            let length = loc["length"].as_u64().unwrap_or(0) as usize;
                            refs.push((lib_name.clone(), start, length));
                        }
                    }
                }
            }
        }
    }
    refs
}

/// Link a library address into bytecode at the specified offsets.
fn link_bytecode(
    bytecode: &mut [u8],
    lib_name: &str,
    lib_addr: H160,
    refs: &[(String, usize, usize)],
) {
    for (name, start, length) in refs {
        if name == lib_name && *length == 20 {
            bytecode[*start..*start + 20].copy_from_slice(lib_addr.as_bytes());
        }
    }
}

// =========================================================================
// Helper: pallet_revive contract deployment and interaction
// =========================================================================

/// Counter for unique CREATE2 salts across deployments.
static DEPLOY_COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// Deploy a contract on Asset Hub via `bare_instantiate`.
/// Returns the deployed contract's H160 address.
///
/// Uses CREATE2 with unique salts to avoid DuplicateContract errors.
/// Must be called inside `AssetHubWestend::execute_with`.
fn deploy_contract(origin: AccountId, code: Vec<u8>, constructor_args: Vec<u8>) -> H160 {
    let mut init_code = code;
    init_code.extend_from_slice(&constructor_args);

    // Use unique salt for each deployment (CREATE2 semantics)
    let counter = DEPLOY_COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let mut salt = [0u8; 32];
    salt[..4].copy_from_slice(&counter.to_le_bytes());

    let result = pallet_revive::Pallet::<AHRuntime>::bare_instantiate(
        asset_hub_westend_runtime::RuntimeOrigin::signed(origin),
        sp_core::U256::from(0),
        pallet_revive::TransactionLimits::WeightAndDeposit {
            weight_limit: Weight::from_parts(500_000_000_000, 50_000_000),
            deposit_limit: 1_000 * DOT,
        },
        pallet_revive::Code::Upload(init_code),
        vec![], // data already appended to code
        Some(salt),
        &pallet_revive::ExecConfig::new_substrate_tx(),
    );

    match &result.result {
        Ok(ret) => {
            eprintln!("  Contract deployed at {:?}", ret.addr);
            ret.addr
        }
        Err(e) => panic!("Contract deployment failed: {e:?}"),
    }
}

/// Call a contract on Asset Hub via `Revive::call` dispatchable (state-modifying).
///
/// Must be called inside `AssetHubWestend::execute_with`.
fn call_contract(origin: AccountId, dest: H160, value: u128, data: Vec<u8>) {
    let result = pallet_revive::Pallet::<AHRuntime>::call(
        asset_hub_westend_runtime::RuntimeOrigin::signed(origin.clone()),
        dest,
        value,
        Weight::from_parts(50_000_000_000, 5_000_000),
        100 * DOT,
        data,
    );
    if let Err(e) = &result {
        eprintln!("  call_contract FAILED: origin={origin:?}, dest={dest:?}, value={value}, error={e:?}");
    }
    assert_ok!(result);
}

/// Read from a contract via `bare_call` (view function, no state change).
/// Returns the raw ABI-encoded return data.
///
/// Must be called inside `AssetHubWestend::execute_with`.
fn view_contract(dest: H160, data: Vec<u8>) -> Vec<u8> {
    // Use Alice as origin for view calls (doesn't matter who, no state change)
    let alice: AccountId = AssetHubWestendSender::get();
    let result = pallet_revive::Pallet::<AHRuntime>::bare_call(
        asset_hub_westend_runtime::RuntimeOrigin::signed(alice),
        dest,
        sp_core::U256::from(0),
        pallet_revive::TransactionLimits::WeightAndDeposit {
            weight_limit: Weight::from_parts(50_000_000_000, 5_000_000),
            deposit_limit: 100 * DOT,
        },
        data,
        &pallet_revive::ExecConfig::new_substrate_tx_without_bump(),
    );

    match result.result {
        Ok(ret) => ret.data,
        Err(e) => panic!("View call failed: {e:?}"),
    }
}

// =========================================================================
// Helper: ABI encoding for Solidity calls
// =========================================================================

fn encode_approve(spender: H160, amount: u128) -> Vec<u8> {
    approveCall {
        spender: to_alloy_addr(spender),
        amount: AlU256::from(amount),
    }
    .abi_encode()
}

fn encode_place_limit_order(
    side: u8,
    price: u128,
    amount: u128,
    origin_account: [u8; 32],
    settlement_account: [u8; 32],
    dest_para_id: u32,
    expire_timestamp: u64,
) -> Vec<u8> {
    placeLimitOrderCall {
        side,
        price: Uint::from(price),
        amount,
        originAccount: FixedBytes::from(origin_account),
        settlementAccount: FixedBytes::from(settlement_account),
        destParaId: dest_para_id,
        expireTimestamp: expire_timestamp,
    }
    .abi_encode()
}

fn encode_cancel_order(order_id: u32, origin_account: [u8; 32]) -> Vec<u8> {
    cancelOrderCall {
        orderId: order_id,
        originAccount: FixedBytes::from(origin_account),
    }
    .abi_encode()
}

fn encode_create_market(
    base: H160,
    quote: H160,
    base_xcm_location: Vec<u8>,
    quote_xcm_location: Vec<u8>,
    tick_size: u128,
    min_order_size: u128,
    max_order_size: u128,
) -> Vec<u8> {
    createMarketCall {
        base: TokenConfig {
            token: to_alloy_addr(base),
            xcmLocation: base_xcm_location.into(),
        },
        quote: TokenConfig {
            token: to_alloy_addr(quote),
            xcmLocation: quote_xcm_location.into(),
        },
        tickSize: Uint::from(tick_size),
        minOrderSize: Uint::from(min_order_size),
        maxOrderSize: max_order_size,
    }
    .abi_encode()
}

// =========================================================================
// Helper: send XCM Transact with pallet_revive::call from PenpalA → AH
// =========================================================================

/// A single pallet_revive::call to include in an XCM Transact.
struct ReviveCall {
    dest: H160,
    value: u128,
    data: Vec<u8>,
}

/// Build and send an XCM program from PenpalA to Asset Hub that executes
/// a single pallet_revive::call via Transact.
///
/// This is the real cross-chain flow: PenpalA sends XCM over HRMP,
/// AH's XCM executor runs the Transact as the sovereign account.
///
/// Note: XCM clears the origin after Transact, so each contract call
/// must be a separate XCM message (e.g., one for approve, one for order).
fn send_xcm_transact_revive(sovereign: &AccountId, call: &ReviveCall) {
    let fee_amount = ASSET_HUB_WESTEND_ED * 500_000;

    let revive_call = asset_hub_westend_runtime::RuntimeCall::Revive(pallet_revive::Call::<
        AHRuntime,
    >::call {
        dest: call.dest,
        value: call.value,
        weight_limit: Weight::from_parts(50_000_000_000, 5_000_000),
        storage_deposit_limit: 100 * DOT,
        data: call.data.clone(),
    });

    let xcm = VersionedXcm::V5(Xcm(vec![
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
            fallback_max_weight: Some(Weight::from_parts(100_000_000_000, 10_000_000)),
        },
        RefundSurplus,
        xcm::prelude::DepositAsset {
            assets: Wild(xcm::prelude::All),
            beneficiary: Location::new(
                0,
                [AccountId32Junction {
                    network: None,
                    id: sovereign.clone().into(),
                }],
            ),
        },
    ]));

    let dest = PenpalA::sibling_location_of(AssetHubWestend::para_id());

    PenpalA::execute_with(|| {
        assert_ok!(<PenpalA as PenpalAPallet>::PolkadotXcm::send(
            <PenpalA as Chain>::RuntimeOrigin::root(),
            bx!(dest.into()),
            bx!(xcm),
        ));
        PenpalA::assert_xcm_pallet_sent();
    });

    AssetHubWestend::execute_with(|| {
        AssetHubWestend::assert_xcmp_queue_success(None);
    });
}

fn query_next_order_id(market: H160) -> u32 {
    let data = view_contract(market, nextOrderIdCall {}.abi_encode());
    u32::abi_decode(&data).expect("decode nextOrderId")
}

fn query_next_claim_id(market: H160) -> u32 {
    let data = view_contract(market, nextClaimIdCall {}.abi_encode());
    u32::abi_decode(&data).expect("decode nextClaimId")
}

fn query_best_bid(market: H160) -> u128 {
    let data = view_contract(market, bestBidCall {}.abi_encode());
    Uint::<96, 2>::abi_decode(&data)
        .expect("decode bestBid")
        .to::<u128>()
}

fn query_balance_of(token: H160, owner: H160) -> u128 {
    let data = view_contract(
        token,
        balanceOfCall {
            owner: to_alloy_addr(owner),
        }
        .abi_encode(),
    );
    let val = AlU256::abi_decode(&data).expect("decode balanceOf");
    val.to::<u128>()
}

fn query_get_market(factory: H160, base: H160, quote: H160) -> H160 {
    let data = view_contract(
        factory,
        getMarketCall {
            base: to_alloy_addr(base),
            quote: to_alloy_addr(quote),
        }
        .abi_encode(),
    );
    let addr = AlAddress::abi_decode(&data).expect("decode getMarket");
    H160::from(addr.0 .0)
}

// =========================================================================
// Helper: map AccountId32 → H160 (pallet-revive's AccountId32Mapper)
// =========================================================================

/// Derive the H160 address that pallet-revive assigns to a Substrate AccountId32.
/// Formula: keccak_256(account_id)[12..]
fn account_to_h160(account: &AccountId) -> H160 {
    let hash = sp_core::hashing::keccak_256(account.as_ref());
    H160::from_slice(&hash[12..])
}

// =========================================================================
// Shared test state
// =========================================================================

struct TestState {
    market: H160,
    factory: H160,
    base_erc20: H160,
    quote_erc20: H160,
}

/// Deploy all contracts and create a pallet-asset market (tGOLD/tUSD).
/// Sets up accounts, funds, assets, and returns the shared TestState.
fn setup_pallet_asset_market() -> (TestState, AccountId, AccountId, AccountId, AccountId, AccountId)
{
    let alice: AccountId = AssetHubWestendSender::get();
    let bob: AccountId = sp_runtime::AccountId32::from(sp_core::sr25519::Public::from_raw(
        sp_core::sr25519::Pair::from_string("//Bob", None)
            .unwrap()
            .public()
            .0,
    ));
    let dave: AccountId = sp_runtime::AccountId32::from(sp_core::sr25519::Public::from_raw(
        sp_core::sr25519::Pair::from_string("//Dave", None)
            .unwrap()
            .public()
            .0,
    ));
    let charlie: AccountId = sp_runtime::AccountId32::from(sp_core::sr25519::Public::from_raw(
        sp_core::sr25519::Pair::from_string("//Charlie", None)
            .unwrap()
            .public()
            .0,
    ));

    let sov_2000 = AssetHubWestend::sovereign_account_id_of(
        AssetHubWestend::sibling_location_of(PenpalA::para_id()),
    );
    eprintln!("[setup] Sovereign account for para 2000: {sov_2000:?}");

    let base_erc20 = asset_id_to_erc20(BASE_ASSET_ID);
    let quote_erc20 = asset_id_to_erc20(QUOTE_ASSET_ID);

    // Fund native balances on AH for all participants
    AssetHubWestend::fund_accounts(vec![
        (alice.clone(), 10_000 * DOT),
        (bob.clone(), 1_000 * DOT),
        (dave.clone(), 1_000 * DOT),
        (sov_2000.clone(), 5_000 * DOT),
    ]);

    // Create test assets and mint to participants
    AssetHubWestend::execute_with(|| {
        type Assets = asset_hub_westend_runtime::Assets;
        type RuntimeOrigin = asset_hub_westend_runtime::RuntimeOrigin;

        // --- Quote asset: tUSD (id=100, 6 decimals) ---
        assert_ok!(Assets::create(
            RuntimeOrigin::signed(alice.clone()),
            codec::Compact(QUOTE_ASSET_ID),
            alice.clone().into(),
            1,
        ));
        assert_ok!(Assets::set_metadata(
            RuntimeOrigin::signed(alice.clone()),
            codec::Compact(QUOTE_ASSET_ID),
            b"tUSD".to_vec(),
            b"tUSD".to_vec(),
            6,
        ));
        assert_ok!(Assets::mint(
            RuntimeOrigin::signed(alice.clone()),
            codec::Compact(QUOTE_ASSET_ID),
            alice.clone().into(),
            1_000_000_000_000,
        ));
        assert_ok!(Assets::mint(
            RuntimeOrigin::signed(alice.clone()),
            codec::Compact(QUOTE_ASSET_ID),
            bob.clone().into(),
            500_000_000_000,
        ));
        assert_ok!(Assets::mint(
            RuntimeOrigin::signed(alice.clone()),
            codec::Compact(QUOTE_ASSET_ID),
            sov_2000.clone().into(),
            100_000_000_000,
        ));

        // --- Base asset: tGOLD (id=101, 6 decimals) ---
        assert_ok!(Assets::create(
            RuntimeOrigin::signed(alice.clone()),
            codec::Compact(BASE_ASSET_ID),
            alice.clone().into(),
            1,
        ));
        assert_ok!(Assets::set_metadata(
            RuntimeOrigin::signed(alice.clone()),
            codec::Compact(BASE_ASSET_ID),
            b"tGOLD".to_vec(),
            b"tGOLD".to_vec(),
            6,
        ));
        assert_ok!(Assets::mint(
            RuntimeOrigin::signed(alice.clone()),
            codec::Compact(BASE_ASSET_ID),
            alice.clone().into(),
            10_000_000_000,
        ));
        assert_ok!(Assets::mint(
            RuntimeOrigin::signed(alice.clone()),
            codec::Compact(BASE_ASSET_ID),
            dave.clone().into(),
            5_000_000_000,
        ));
    });

    // Fund Charlie on PenpalA (for sending XCM)
    PenpalA::fund_accounts(vec![(charlie.clone(), 100 * DOT)]);

    // Register tGOLD as a foreign asset on PenpalA for cross-chain settlement
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
        assert_ok!(ForeignAssets::force_create(
            <PenpalA as Chain>::RuntimeOrigin::root(),
            base_on_penpal,
            charlie.clone().into(),
            true,
            1,
        ));
    });

    // Map accounts in pallet_revive
    AssetHubWestend::execute_with(|| {
        type Revive = asset_hub_westend_runtime::Revive;
        type RuntimeOrigin = asset_hub_westend_runtime::RuntimeOrigin;

        assert_ok!(Revive::map_account(RuntimeOrigin::signed(alice.clone())));
        assert_ok!(Revive::map_account(RuntimeOrigin::signed(bob.clone())));
        assert_ok!(Revive::map_account(RuntimeOrigin::signed(dave.clone())));
        assert_ok!(Revive::map_account(RuntimeOrigin::signed(sov_2000.clone())));
        eprintln!("[setup] Accounts mapped in pallet_revive");
    });

    // Deploy DLOB contracts on AH
    let state: TestState = AssetHubWestend::execute_with(|| {
        eprintln!("[setup] Deploying contracts...");

        // 1. Deploy libraries (RedBlackTree + XcmBuilder)
        let rbt_code = read_bytecode("../out/RedBlackTree.sol/RedBlackTree.json");
        let rbt_addr = deploy_contract(alice.clone(), rbt_code, vec![]);

        let xcm_builder_code = read_bytecode("../out/XcmBuilder.sol/XcmBuilder.json");
        let xcm_builder_addr = deploy_contract(alice.clone(), xcm_builder_code, vec![]);

        // 2. Deploy DLOB implementation (linked with RedBlackTree + XcmBuilder)
        let dlob_artifact = "../out/DLOB.sol/DLOB.json";
        let mut dlob_code = read_bytecode(dlob_artifact);
        let link_refs = read_link_references(dlob_artifact);
        link_bytecode(&mut dlob_code, "RedBlackTree", rbt_addr, &link_refs);
        link_bytecode(&mut dlob_code, "XcmBuilder", xcm_builder_addr, &link_refs);
        let dlob_impl = deploy_contract(alice.clone(), dlob_code, vec![]);

        // 3. Deploy DLOBFactory(xcm_precompile, system_precompile, dlob_impl)
        let factory_code = read_bytecode("../out/DLOBFactory.sol/DLOBFactory.json");
        let constructor_args = (
            to_alloy_addr(H160::from(XCM_PRECOMPILE)),
            to_alloy_addr(H160::from(SYSTEM_PRECOMPILE)),
            to_alloy_addr(dlob_impl),
        )
            .abi_encode();
        let factory = deploy_contract(alice.clone(), factory_code, constructor_args);

        // 4. Create market (tGOLD/tUSD) — pallet assets, no custom XCM location
        let create_data = encode_create_market(
            base_erc20,
            quote_erc20,
            vec![],
            vec![],
            TICK_SIZE,
            MIN_ORDER_SIZE,
            MAX_ORDER_SIZE,
        );
        call_contract(alice.clone(), factory, 0, create_data);
        let market = query_get_market(factory, base_erc20, quote_erc20);
        assert_ne!(market, H160::zero(), "Market should not be zero address");
        eprintln!("[setup] Market deployed at {:?}", market);

        // Set minCrossChainFee
        let fee_data = setMinCrossChainFeeCall {
            feeInPlanck: 10 * DOT as u128,
        }
        .abi_encode();
        call_contract(alice.clone(), factory, 0, fee_data);

        // Pre-approve the market contract for local participants
        let large_allowance: u128 = 1_000_000_000_000;
        call_contract(
            bob.clone(),
            quote_erc20,
            0,
            encode_approve(market, large_allowance),
        );
        call_contract(
            dave.clone(),
            base_erc20,
            0,
            encode_approve(market, large_allowance),
        );

        TestState {
            market,
            factory,
            base_erc20,
            quote_erc20,
        }
    });

    eprintln!("═══════════════════════════════════════════════════════════════");
    eprintln!(" Setup complete!");
    eprintln!("═══════════════════════════════════════════════════════════════");

    (state, alice, bob, dave, charlie, sov_2000)
}
