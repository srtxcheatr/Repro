// src by SRT X CHEATS. Copy right SRT X CHEATS
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
// src by SRT X CHEATS. Copy right SRT X CHEATS
}
