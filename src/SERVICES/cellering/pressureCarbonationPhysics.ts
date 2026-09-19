// Physically grounded CO2 equilibrium + first-order headspace transfer helpers.
//
// Equilibrium pressure uses the standard brewing regression that reproduces
// the ASBC/Brewers Association pressure-temperature-carbonation table.
// Dynamics use dC/dt = kLa * (C* - C), where C* is equilibrium carbonation.
//
// Pressure values are gauge bar, temperatures are °C, carbonation is vol/vol.

const BAR_TO_PSI = 14.5037738;

export function equilibriumPressureBar(
  temperatureC: number,
  carbonationVolumes: number,
): number | null {
  if (
    !Number.isFinite(temperatureC) ||
    !Number.isFinite(carbonationVolumes) ||
    carbonationVolumes <= 0
  ) return null;

  const tF = temperatureC * 9 / 5 + 32;
  const v = carbonationVolumes;
  const psi =
    -16.6999
    - 0.0101059 * tF
    + 0.00116512 * tF * tF
    + 0.173354 * tF * v
    + 4.24267 * v
    - 0.0684226 * v * v;

  return Number.isFinite(psi) ? psi / BAR_TO_PSI : null;
}

export function equilibriumCarbonationVolumes(
  temperatureC: number,
  gaugePressureBar: number,
): number | null {
  if (
    !Number.isFinite(temperatureC) ||
    !Number.isFinite(gaugePressureBar)
  ) return null;

  const tF = temperatureC * 9 / 5 + 32;
  const psi = gaugePressureBar * BAR_TO_PSI;

  const a = -0.0684226;
  const b = 0.173354 * tF + 4.24267;
  const c =
    -16.6999
    - 0.0101059 * tF
    + 0.00116512 * tF * tF
    - psi;

  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;

  const root = Math.sqrt(discriminant);
  const candidates = [
    (-b + root) / (2 * a),
    (-b - root) / (2 * a),
  ].filter((value) => Number.isFinite(value) && value > 0 && value < 10);

  return candidates.length ? Math.min(...candidates) : null;
}

export function evolveCarbonation(args: {
  carbonation: number;
  pressureBar: number;
  temperatureC: number;
  kPerHour: number;
  hours: number;
}): number | null {
  const equilibrium = equilibriumCarbonationVolumes(
    args.temperatureC,
    args.pressureBar,
  );
  if (
    equilibrium === null ||
    !Number.isFinite(args.carbonation) ||
    !Number.isFinite(args.kPerHour) ||
    args.kPerHour < 0 ||
    !Number.isFinite(args.hours) ||
    args.hours < 0
  ) return null;

  const decay = Math.exp(-args.kPerHour * args.hours);
  return equilibrium - (equilibrium - args.carbonation) * decay;
}
