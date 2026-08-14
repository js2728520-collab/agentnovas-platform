export type ExchangeCredential={apiKey:string;secretKey:string;passphrase?:string};
const encoder=new TextEncoder(),decoder=new TextDecoder();
function bytesToBase64(bytes:Uint8Array){let value="";for(const byte of bytes)value+=String.fromCharCode(byte);return btoa(value)}
function base64ToBytes(value:string){const raw=atob(value);return Uint8Array.from(raw,c=>c.charCodeAt(0))}
async function encryptionKey(){const secret=process.env.EXCHANGE_CREDENTIAL_ENCRYPTION_KEY;if(!secret||secret.length<32)throw new Error("交易所凭证加密密钥尚未配置");const digest=await crypto.subtle.digest("SHA-256",encoder.encode(secret));return crypto.subtle.importKey("raw",digest,"AES-GCM",false,["encrypt","decrypt"])}
export async function encryptExchangeCredential(value:ExchangeCredential){const iv=crypto.getRandomValues(new Uint8Array(12)),key=await encryptionKey(),encrypted=await crypto.subtle.encrypt({name:"AES-GCM",iv},key,encoder.encode(JSON.stringify(value)));return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`}
export async function decryptExchangeCredential(value:string):Promise<ExchangeCredential>{const [version,iv,data]=value.split(".");if(version!=="v1"||!iv||!data)throw new Error("无法识别交易所凭证格式");const key=await encryptionKey(),plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:base64ToBytes(iv)},key,base64ToBytes(data));return JSON.parse(decoder.decode(plain))}
export function maskedKey(key:string){return key.length<8?"••••••••":`${key.slice(0,4)}••••${key.slice(-4)}`}
