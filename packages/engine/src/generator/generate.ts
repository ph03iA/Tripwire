import type { Label, TripwireEvent } from "../types.js";
import { background } from "./background.js";
import { decoys } from "./decoys.js";
import { makeRng } from "./rng.js";
import { scenarios } from "./scenarios.js";
import { makeWorld, profiles } from "./world.js";

const MAX_SEED = 0xffffffff; // the PRNG keeps 32 bits, so a larger seed would silently repeat a smaller one

/** Builds the full synthetic stream. Pure: the same seed always returns the same events, labels and profiles. */
export function generate(seed = 42, total = 2000) {
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) {
    throw new RangeError(`seed must be an integer from 0 to ${MAX_SEED}, got ${seed}`);
  }
  const rng = makeRng(seed);
  const world = makeWorld(rng);
  const pool = rng.shuffle(world.accounts);
  const take = () => pool.pop()!; // each planted story gets accounts of its own
  const planted = [...scenarios(rng, world, take), ...decoys(rng, world, take)]; // first: blackouts, decoy devices
  if (total <= planted.length) throw new RangeError(`total must be more than the ${planted.length} planted events, got ${total}`);
  const accounts = profiles(world); // before background() adds devices, payees and banks
  const drafts = [...planted, ...background(rng, world, total - planted.length)].sort((a, b) => a.t - b.t);

  const events: TripwireEvent[] = [];
  const labels: Label[] = [];
  drafts.forEach(({ t, label, ...rest }, i) => {
    const id = `evt_${String(i + 1).padStart(6, "0")}`;
    events.push({ id, ts: new Date(t).toISOString(), ...rest } as TripwireEvent);
    labels.push({ eventId: id, ...label });
  });
  return { events, labels, accounts };
}
