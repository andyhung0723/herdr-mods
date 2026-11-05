/**
 * Dog state machine for desktop pet animation
 * Total loop duration: 48 ticks * 250ms = 12 seconds
 */
export function computeDogState(tickCount) {
  const tick = tickCount % 48;
  const frame = (tick % 2) + 1;

  // Phase 1: Ticks 0..15 (4s) - Walk Right (offset moves from 0px to 20px)
  if (tick < 16) {
    const offset = Math.round((tick / 15) * 20);
    return {
      mode: "walk_right",
      frame,
      offset,
      svg: `dog-right-f${frame}.svg`,
    };
  }

  // Phase 2: Ticks 16..23 (2s) - Sit & Wag tail at right edge
  if (tick < 24) {
    return {
      mode: "sit",
      frame,
      offset: 20,
      svg: `dog-sit-f${frame}.svg`,
    };
  }

  // Phase 3: Ticks 24..39 (4s) - Walk Left (offset moves from 20px back to 0px)
  if (tick < 40) {
    const offset = Math.round(((39 - tick) / 15) * 20);
    return {
      mode: "walk_left",
      frame,
      offset,
      svg: `dog-left-f${frame}.svg`,
    };
  }

  // Phase 4: Ticks 40..47 (2s) - Sit & Wag tail at left edge (start position)
  return {
    mode: "sit",
    frame,
    offset: 0,
    svg: `dog-sit-f${frame}.svg`,
  };
}
