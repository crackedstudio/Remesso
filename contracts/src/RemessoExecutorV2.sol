// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ISwapRouter02} from "./ISwapRouter02.sol";

/**
 * @title  RemessoExecutor
 * @notice Recurring, policy-bound remittances on Celo.
 *
 * The problem this solves: a sender wants to set up a remittance once and have
 * it run unattended, without handing anyone a spending key.
 *
 * The shape of the answer:
 *
 *   1. The sender calls `approve()` on the funding token (USDT) for this
 *      contract, then `createSchedule()` with a policy — destination, amount
 *      per run, minimum interval, floor exchange rate, expiry, run cap.
 *   2. Remesso's backend (the `executor`) calls `executeRun()` when a schedule
 *      is due. It supplies only a slippage bound. It cannot change the amount,
 *      the destination, the cadence, or anything else.
 *   3. Each run pulls exactly `amountIn` from the sender, swaps it to cNGN on
 *      Uniswap V3, and delivers straight to the schedule's destination.
 *
 * What the executor CANNOT do, by construction:
 *   - send to any address other than the one the sender fixed at creation
 *   - move more than `amountIn` per run, or run more often than `interval`
 *   - accept a worse rate than the sender's `minRateE6` floor
 *   - keep running after `expiresAt` or past `maxRuns`
 *   - touch a schedule the sender has paused or cancelled
 *
 * The sender's ERC20 allowance is the outermost cap and is revocable at any
 * time without our cooperation. The contract custodies nothing: funds move
 * from sender to destination inside a single transaction.
 *
 * @dev V2. Changes from the deployed V1 (0xC7eF75fC…1189), all from the
 *      2026-09-14 security review:
 *
 *      - The swap now lands in this contract and is forwarded with an explicit
 *        `safeTransfer`. V1 paid the recipient straight from the Uniswap pool,
 *        which made the POOL the cNGN sender-of-record — and cNGN only burns
 *        (its signal to pay naira) when the transferor is on its
 *        external-sender whitelist. A public pool is not and cannot be, so
 *        every bank payout would have silently never paid out.
 *      - Delivery is asserted on the recipient's measured balance delta, not
 *        on the router's self-reported return value.
 *      - `destination` rejects the router's MSG_SENDER/ADDRESS_THIS sentinels.
 *      - The floor is validated at creation, not merely `minRateE6 != 0`.
 *      - `poolFee` is pinned per schedule at consent time.
 *      - Schedules must expire, and the sender can refresh their floor.
 *      - `renounceOwnership` is disabled.
 *
 * @dev Destination is deliberately immutable. For wallet payouts it is the
 *      recipient's address. For bank payouts it is the cNGN redemption address
 *      the sender consented to at setup — the bank details themselves live off
 *      chain, in the cNGN API. Changing where money goes requires cancelling
 *      and creating a new schedule, which is the point.
 */
contract RemessoExecutorV2 is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Where the swapped cNGN ends up. Purely informational on-chain —
    /// the envelope is enforced through `destination` either way — but it lets
    /// indexers and the backend tell the two flows apart.
    enum PayoutType {
        Wallet, // straight to the recipient's own wallet
        BankRedemption // to a cNGN redemption address; naira lands in a bank account
    }

    struct Schedule {
        address sender; //  slot 0
        uint64 interval; //  minimum seconds between runs
        uint32 maxRuns; //  0 = unlimited
        address destination; //  slot 1  — immutable after creation
        uint64 nextRunAt; //  earliest timestamp the next run may execute
        uint32 runsExecuted;
        uint128 amountIn; //  slot 2  — funding-token units pulled per run
        uint96 minRateE6; //  floor: min tokenOut per 1e6 tokenIn
        uint24 poolFee; //  pinned at consent: 16+12+3 = 31 bytes, still slot 2
        uint64 expiresAt; //  slot 3  — always set; schedules must expire
        PayoutType payoutType;
        bool active; //  sender's pause switch
        bool cancelled; //  terminal; cannot be undone by anyone
    }

    // --- immutable config -------------------------------------------------

    IERC20 public immutable tokenIn; // USDT on Celo
    IERC20 public immutable tokenOut; // cNGN on Celo
    ISwapRouter02 public immutable router;

    // --- mutable config (owner) -------------------------------------------

    /// @notice The only address allowed to trigger runs.
    address public executor;

    /// @notice Uniswap V3 fee tier for the tokenIn/tokenOut pool. 100 = 0.01%.
    uint24 public poolFee;

    // --- state ------------------------------------------------------------

    /// @notice Longest a schedule may run before the sender must re-consent.
    /// @dev The floor is denominated in a currency that has lost most of its
    ///      value against USD within a single schedule's plausible lifetime. A
    ///      perpetual schedule is a perpetual standing order at a price nobody
    ///      has looked at since signup, so V1's `expiresAt == 0` is gone.
    uint64 public constant MAX_LIFETIME = 365 days;

    /// @notice Upper bound on `interval`. V1 checked only `!= 0`, so a near-max
    ///         value passed every gate and then panicked on the checked add in
    ///         executeRun, wedging the schedule permanently "due".
    uint64 public constant MAX_INTERVAL = 365 days;

    uint256 public nextScheduleId = 1;
    mapping(uint256 => Schedule) private _schedules;
    mapping(address => uint256[]) private _schedulesBySender;

    // --- events -----------------------------------------------------------

    event ScheduleCreated(
        uint256 indexed id,
        address indexed sender,
        address indexed destination,
        uint128 amountIn,
        uint64 interval,
        uint96 minRateE6,
        uint32 maxRuns,
        uint64 expiresAt,
        PayoutType payoutType
    );
    event RunExecuted(
        uint256 indexed id,
        address indexed sender,
        address indexed destination,
        uint128 amountIn,
        uint256 amountOut,
        uint32 runsExecuted,
        uint64 nextRunAt
    );
    event ScheduleActiveSet(uint256 indexed id, bool active);
    event MinRateUpdated(uint256 indexed id, uint96 previous, uint96 current);
    event ScheduleCancelled(uint256 indexed id);
    event ExecutorUpdated(address indexed previous, address indexed current);
    event PoolFeeUpdated(uint24 previous, uint24 current);

    // --- errors -----------------------------------------------------------

    error NotExecutor();
    error NotScheduleOwner();
    error ZeroAddress();
    error InvalidAmount();
    error InvalidInterval();
    error InvalidRate();
    error ScheduleInactive();
    error ScheduleIsCancelled();
    error ScheduleExpired();
    error RunCapReached();
    error NotDue(uint64 nextRunAt);
    error SlippageBoundBelowFloor(uint256 provided, uint256 floor);
    error InsufficientOutput(uint256 received, uint256 floor);
    error InvalidDestination();
    error DegenerateFloor();
    error ScheduleLifetimeTooLong();
    error RenounceDisabled();

    modifier onlyExecutor() {
        if (msg.sender != executor) revert NotExecutor();
        _;
    }

    constructor(address _tokenIn, address _tokenOut, address _router, address _executor, uint24 _poolFee)
        Ownable(msg.sender)
    {
        if (_tokenIn == address(0) || _tokenOut == address(0) || _router == address(0) || _executor == address(0)) {
            revert ZeroAddress();
        }
        tokenIn = IERC20(_tokenIn);
        tokenOut = IERC20(_tokenOut);
        router = ISwapRouter02(_router);
        executor = _executor;
        poolFee = _poolFee;
        emit ExecutorUpdated(address(0), _executor);
    }

    // =====================================================================
    //                              SENDER
    // =====================================================================

    /**
     * @notice Authorise a recurring remittance. Called once, by the sender.
     * @param destination  Where cNGN is delivered. Immutable for the life of
     *                     the schedule.
     * @param amountIn     Funding-token units pulled per run (USDT, 6dp).
     * @param interval     Minimum seconds between runs.
     * @param minRateE6    Floor rate: minimum tokenOut per 1e6 tokenIn. With
     *                     both tokens at 6dp and a market near 1368 NGN/USD,
     *                     a 2% floor is about 1_340_000_000.
     * @param maxRuns      Hard cap on executions. 0 = unlimited.
     * @param expiresAt    Unix timestamp after which no run may fire. 0 = never.
     * @param firstRunAt   Earliest timestamp for run #1. 0 = immediately.
     */
    function createSchedule(
        address destination,
        uint128 amountIn,
        uint64 interval,
        uint96 minRateE6,
        uint32 maxRuns,
        uint64 expiresAt,
        uint64 firstRunAt,
        PayoutType payoutType
    ) external whenNotPaused returns (uint256 id) {
        // SwapRouter02 reserves address(1) as MSG_SENDER and address(2) as
        // ADDRESS_THIS and rewrites the recipient before paying out. V1 checked
        // only address(0) — the sentinel of the ORIGINAL SwapRouter — so a
        // schedule pointed at address(2) paid the router, where the
        // permissionless sweepToken let anyone take it, while RunExecuted
        // reported a clean delivery.
        if (
            uint160(destination) < 0x10000 || destination == address(this)
                || destination == address(router)
        ) revert InvalidDestination();
        if (amountIn == 0) revert InvalidAmount();
        if (interval == 0 || interval > MAX_INTERVAL) revert InvalidInterval();
        if (minRateE6 == 0) revert InvalidRate();

        // Validate the number actually enforced, not just its input. Integer
        // division means amountIn * minRateE6 < 1e6 yields floor == 0, and both
        // guards then read `x < 0` and can never fire.
        if ((uint256(amountIn) * uint256(minRateE6)) / 1e6 == 0) revert DegenerateFloor();

        // Every schedule expires. See MAX_LIFETIME.
        if (expiresAt == 0) revert ScheduleExpired();
        if (expiresAt <= block.timestamp) revert ScheduleExpired();
        if (expiresAt > block.timestamp + MAX_LIFETIME) revert ScheduleLifetimeTooLong();

        id = nextScheduleId++;
        _schedules[id] = Schedule({
            sender: msg.sender,
            interval: interval,
            maxRuns: maxRuns,
            destination: destination,
            nextRunAt: firstRunAt == 0 ? uint64(block.timestamp) : firstRunAt,
            runsExecuted: 0,
            amountIn: amountIn,
            minRateE6: minRateE6,
            poolFee: poolFee, //  pinned: setPoolFee must not re-route live schedules
            expiresAt: expiresAt,
            payoutType: payoutType,
            active: true,
            cancelled: false
        });
        _schedulesBySender[msg.sender].push(id);

        emit ScheduleCreated(id, msg.sender, destination, amountIn, interval, minRateE6, maxRuns, expiresAt, payoutType);
    }

    /// @notice Pause or resume a schedule. Sender only.
    /// @dev A cancelled schedule is terminal and cannot be resumed here.
    function setScheduleActive(uint256 id, bool active) external {
        Schedule storage s = _schedules[id];
        if (s.sender != msg.sender) revert NotScheduleOwner();
        if (s.cancelled) revert ScheduleIsCancelled();
        s.active = active;
        emit ScheduleActiveSet(id, active);
    }

    /// @notice Refresh the floor rate on a live schedule. Sender only.
    /// @dev V1 had no setter, so a floor set against one market protected a
    ///      remittance executed against another. Cancelling and recreating was
    ///      the only remedy, which requires the sender to be watching — the
    ///      opposite of an unattended standing order.
    function setMinRate(uint256 id, uint96 minRateE6) external {
        Schedule storage s = _schedules[id];
        if (s.sender != msg.sender) revert NotScheduleOwner();
        if (s.cancelled) revert ScheduleIsCancelled();
        if (minRateE6 == 0) revert InvalidRate();
        if ((uint256(s.amountIn) * uint256(minRateE6)) / 1e6 == 0) revert DegenerateFloor();
        emit MinRateUpdated(id, s.minRateE6, minRateE6);
        s.minRateE6 = minRateE6;
    }

    /// @notice Permanently retire a schedule. Sender only.
    /// @dev Revoking the ERC20 allowance is the belt-and-braces version and
    ///      needs nothing from this contract.
    function cancelSchedule(uint256 id) external {
        Schedule storage s = _schedules[id];
        if (s.sender != msg.sender) revert NotScheduleOwner();
        s.active = false;
        s.cancelled = true; // terminal — `setScheduleActive` will not undo this
        emit ScheduleCancelled(id);
    }

    // =====================================================================
    //                             EXECUTOR
    // =====================================================================

    /**
     * @notice Execute one run of a due schedule.
     * @param id                 Schedule to run.
     * @param amountOutMinimum   Backend's slippage bound, from a live quote.
     *                           Must be at least the sender's stored floor —
     *                           so a compromised executor cannot set it to 0
     *                           and hand the trade to a sandwich bot.
     */
    function executeRun(uint256 id, uint256 amountOutMinimum)
        external
        onlyExecutor
        whenNotPaused
        nonReentrant
        returns (uint256 amountOut)
    {
        Schedule storage s = _schedules[id];

        if (s.cancelled) revert ScheduleIsCancelled();
        if (!s.active) revert ScheduleInactive();
        if (s.expiresAt != 0 && block.timestamp > s.expiresAt) revert ScheduleExpired();
        if (s.maxRuns != 0 && s.runsExecuted >= s.maxRuns) revert RunCapReached();
        if (block.timestamp < s.nextRunAt) revert NotDue(s.nextRunAt);

        uint256 floor = (uint256(s.amountIn) * uint256(s.minRateE6)) / 1e6;
        if (amountOutMinimum < floor) revert SlippageBoundBelowFloor(amountOutMinimum, floor);

        // --- effects before interactions ---
        uint128 amount = s.amountIn;
        address dest = s.destination;
        address from = s.sender;

        unchecked {
            s.runsExecuted += 1;
        }
        // Cadence is measured from now, not from the scheduled time. A schedule
        // that was down for a week resumes; it does not fire seven catch-up runs.
        s.nextRunAt = uint64(block.timestamp) + s.interval;
        if (s.maxRuns != 0 && s.runsExecuted >= s.maxRuns) {
            s.active = false;
        }

        // --- interactions ---
        tokenIn.safeTransferFrom(from, address(this), amount);
        tokenIn.forceApprove(address(router), amount);

        // The swap lands HERE, not at the destination. Two reasons, both from
        // the security review:
        //
        //   1. cNGN only burns — its signal to pay naira — when the transferor
        //      is on its external-sender whitelist. Paying straight from the
        //      pool made the POOL the transferor, and a public pool is not
        //      whitelisted, so bank payouts would have silently never paid.
        //      Forwarding from here makes this contract the sender-of-record:
        //      one stable address that can be whitelisted.
        //   2. It lets delivery be asserted on a measured balance delta rather
        //      than on the router's self-reported return value.
        uint256 balanceBefore = tokenOut.balanceOf(address(this));

        amountOut = router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                fee: s.poolFee, // pinned at consent, not read from mutable config
                recipient: address(this),
                amountIn: amount,
                amountOutMinimum: amountOutMinimum,
                sqrtPriceLimitX96: 0
            })
        );

        uint256 received = tokenOut.balanceOf(address(this)) - balanceBefore;
        if (received < floor) revert InsufficientOutput(received, floor);

        tokenIn.forceApprove(address(router), 0);

        // Nothing rests here: what arrived is forwarded in the same call.
        tokenOut.safeTransfer(dest, received);
        amountOut = received;

        emit RunExecuted(id, from, dest, amount, amountOut, s.runsExecuted, s.nextRunAt);
    }

    // =====================================================================
    //                              VIEWS
    // =====================================================================

    function getSchedule(uint256 id) external view returns (Schedule memory) {
        return _schedules[id];
    }

    function schedulesOf(address sender) external view returns (uint256[] memory) {
        return _schedulesBySender[sender];
    }

    /// @notice Everything the backend needs to decide whether to attempt a run.
    /// @dev Checked off-chain first so a doomed run never costs gas.
    function runnability(uint256 id)
        external
        view
        returns (bool due, bool funded, bool approved, uint256 floor, uint64 nextRunAt)
    {
        Schedule memory s = _schedules[id];
        floor = (uint256(s.amountIn) * uint256(s.minRateE6)) / 1e6;
        nextRunAt = s.nextRunAt;
        // !paused() included deliberately. V1 omitted it, so while the
        // contract was paused this reported due == true and the backend — which
        // opens a cNGN redemption BEFORE calling executeRun — committed an
        // irreversible off-chain payout instruction for a run that then
        // reverted, every cycle, for the duration of the incident.
        due = !paused() && s.active && !s.cancelled && block.timestamp >= s.nextRunAt
            && (s.expiresAt == 0 || block.timestamp <= s.expiresAt) && (s.maxRuns == 0 || s.runsExecuted < s.maxRuns);
        funded = tokenIn.balanceOf(s.sender) >= s.amountIn;
        approved = tokenIn.allowance(s.sender, address(this)) >= s.amountIn;
    }

    // =====================================================================
    //                              ADMIN
    // =====================================================================

    function setExecutor(address _executor) external onlyOwner {
        if (_executor == address(0)) revert ZeroAddress();
        emit ExecutorUpdated(executor, _executor);
        executor = _executor;
    }

    /// @notice Default fee tier for NEW schedules only.
    /// @dev Live schedules keep the tier pinned at their creation. In V1 this
    ///      was read at swap time, so one owner write re-routed every existing
    ///      schedule — and since only the 0.01% pool exists, any other value
    ///      silently bricked them all while emitting no Paused event.
    function setPoolFee(uint24 _poolFee) external onlyOwner {
        emit PoolFeeUpdated(poolFee, _poolFee);
        poolFee = _poolFee;
    }

    /// @notice Global stop. Blocks new schedules and all runs; senders can
    /// still pause and cancel their own.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Disabled. Ownable2Step guards transferOwnership but leaves the
    ///         strictly more destructive renounceOwnership as a single
    ///         unconfirmed call; pause() followed by renounce would strand
    ///         every schedule with unpause() permanently unreachable.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// @notice Sweep tokens stranded by a failed interaction.
    /// @dev The contract holds no user funds between transactions, so this can
    ///      only ever recover dust or a mistaken direct transfer.
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
    }
}
