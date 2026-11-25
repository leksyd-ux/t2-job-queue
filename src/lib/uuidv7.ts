import { v7 as uuidv7Generator, validate as uuidValidate, version as uuidVersion } from "uuid";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function generateUUIDv7(): string {
  return uuidv7Generator();
}

export function isValidUUID(id: string): boolean {
  if (typeof id !== "string") return false;
  return UUID_REGEX.test(id) && uuidValidate(id);
}

export function isValidUUIDv7(id: string): boolean {
  if (!isValidUUID(id)) return false;
  return uuidVersion(id) === 7;
}
