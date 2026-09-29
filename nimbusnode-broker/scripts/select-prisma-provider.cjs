const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const schemaPath = path.join(root, "prisma", "schema.prisma");
const lockPath = path.join(root, "prisma", "migrations", "migration_lock.toml");
const nodeEnv = (process.env.NODE_ENV || "development").toLowerCase();
const provider = nodeEnv === "production" ? "postgresql" : "sqlite";

let schema = fs.readFileSync(schemaPath, "utf8");
if (!/provider\s*=\s*"(?:sqlite|postgresql)"/.test(schema)) {
  throw new Error("Could not find the Prisma datasource provider in prisma/schema.prisma");
}
schema = schema.replace(/provider\s*=\s*"(?:sqlite|postgresql)"/, `provider = "${provider}"`);
fs.writeFileSync(schemaPath, schema);

if (fs.existsSync(lockPath)) {
  let lock = fs.readFileSync(lockPath, "utf8");
  lock = lock.replace(/provider\s*=\s*"(?:sqlite|postgresql)"/, `provider = "${provider}"`);
  fs.writeFileSync(lockPath, lock);
}

console.log(`Prisma provider selected: ${provider} (NODE_ENV=${nodeEnv})`);
