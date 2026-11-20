// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { monitor, settlementEvent } from "./watch";
import type { PhoneAccount } from "./accounts";

afterEach(() => vi.useRealTimers());
it("dispatches on a Gemini settlement frame without waiting for the polling interval", async () => {
  vi.useFakeTimers();
  const check = vi.fn(async () => {}),
    terminate = vi.fn();
  let deliver!: () => void;
  const done = monitor({} as PhoneAccount, 65000, check, (_account, wake) => {
    deliver = wake;
    return { terminate };
  });
  await vi.advanceTimersByTimeAsync(1);
  expect(check).toHaveBeenCalledTimes(1);
  expect(settlementEvent('{"e":"positionReport","P":[{"a":[{"t":"position","v":"0"}]}]}')).toBe(
    false,
  );
  if (settlementEvent('{"e":"positionReport","P":[{"a":[{"t":"settlement_payout","v":"0"}]}]}'))
    deliver();
  expect(check).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5000);
  expect(check).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(60000);
  await done;
  expect(terminate).toHaveBeenCalledOnce();
});
