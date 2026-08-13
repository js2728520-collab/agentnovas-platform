import {getDb} from "@/db";

export async function GET(){
  let database="ok";
  try{getDb()}catch{database="missing"}
  const encryption=Boolean(process.env.EXCHANGE_CREDENTIAL_ENCRYPTION_KEY&&process.env.EXCHANGE_CREDENTIAL_ENCRYPTION_KEY.length>=32);
  return Response.json({status:database==="ok"&&encryption?"ready":"degraded",checks:{database,encryptionKey:encryption,emergencyStop:process.env.PLATFORM_EMERGENCY_STOP==="true",marketProvider:"binance"},timestamp:new Date().toISOString()},{headers:{"cache-control":"no-store, max-age=0"}});
}
