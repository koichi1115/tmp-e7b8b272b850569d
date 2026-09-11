export const VEHICLE_IDS = ["street", "alley"] as const;

export type VehicleId = (typeof VEHICLE_IDS)[number];

export type VehicleDefinition = Readonly<{
  id: VehicleId;
  name: string;
  maxSpeed: number;
  color: string;
  darkColor: string;
  allowedHighways: readonly string[];
}>;

export const DEFAULT_VEHICLE_ID: VehicleId = "street";

export const VEHICLES: readonly VehicleDefinition[] = [
  {
    id: "street",
    name: "まちぐるま",
    maxSpeed: 17,
    color: "#e35b45",
    darkColor: "#a83f34",
    allowedHighways: [
      "residential",
      "tertiary",
      "secondary",
      "unclassified",
    ],
  },
  {
    id: "alley",
    name: "こみちぐるま",
    maxSpeed: 11,
    color: "#4da7a5",
    darkColor: "#327775",
    allowedHighways: [
      "residential",
      "tertiary",
      "service",
      "unclassified",
    ],
  },
];

export const vehicleById = (vehicleId: VehicleId): VehicleDefinition => {
  const vehicle = VEHICLES.find((candidate) => candidate.id === vehicleId);
  if (!vehicle) {
    throw new Error(`Unknown vehicle ${vehicleId}.`);
  }
  return vehicle;
};

export const isRoadPassable = (
  vehicleId: VehicleId,
  highway: string,
): boolean =>
  vehicleById(vehicleId).allowedHighways.includes(highway);

export const vehicleMaxSpeed = (vehicleId: VehicleId): number =>
  vehicleById(vehicleId).maxSpeed;

export const clampVehicleSpeed = (
  speed: number,
  vehicleId: VehicleId,
  maximumReverseSpeed = -6,
): number =>
  Math.max(
    maximumReverseSpeed,
    Math.min(vehicleMaxSpeed(vehicleId), speed),
  );