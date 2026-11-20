// The fixture window holds no proof key; ?device= stands in for this device's short ID,
// so a changed value is this device with a new key.
const id = () => new URLSearchParams(location.search).get("device") ?? "R2DK";
export const loadOwnDeviceShortId = async () => id();
export const useOwnDeviceShortId = () => id();
