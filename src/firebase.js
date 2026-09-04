import admin from 'firebase-admin';
import cors from 'cors';
let app=null;
export function getFirebaseApp(){
  if(app)return app;
  const json=process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if(!json)throw new Error('Server misconfigured: FIREBASE_SERVICE_ACCOUNT_JSON is not set');
  let creds; try{creds=JSON.parse(json);}catch{throw new Error('Server misconfigured: FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON');}
  app=admin.initializeApp({credential:admin.credential.cert(creds)}); return app;
}
export function db(){getFirebaseApp();return admin.firestore();}
export async function requireFirebaseUid(req,res,next){const header=req.headers.authorization||'',m=header.match(/^Bearer\s+(.+)$/i);if(!m)return res.status(401).json({success:false,error:'Missing Authorization header'});try{getFirebaseApp();const decoded=await admin.auth().verifyIdToken(m[1]);req.uid=decoded.uid;req.email=decoded.email||'';next();}catch{return res.status(401).json({success:false,error:'Invalid or expired login. Please refresh and try again.'});}}
export function requireAdmin(req,res,next){const expected=process.env.ADMIN_SECRET,given=req.headers['x-admin-secret']||'';if(!expected||given!==expected)return res.status(401).json({success:false,error:'Not authorized'});next();}
const ALLOWED_EXACT_ORIGINS=['https://cheats.xo.je','https://www.cheats.xo.je','https://bronzx.web.app','https://bronzx.firebaseapp.com','https://srtstorev5.onrender.com','https://srtxdevv.free.nf','https://srtxcheats.site.je'];
export const userCors=cors({origin(origin,cb){if(!origin||ALLOWED_EXACT_ORIGINS.includes(origin))return cb(null,true);try{const host=new URL(origin).hostname;if(host.endsWith('.onrender.com'))return cb(null,true);}catch{}return cb(null,false);}});
export const adminCors=cors({origin:'https://adminpanels.me'});
