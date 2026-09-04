import express from 'express';
import { asyncHandler } from '../src/asyncHandler.js';
import { db, requireFirebaseUid, userCors } from '../src/firebase.js';
import { telegramNotify, telegramFormat, esc } from '../src/telegram.js';
import { catalogForRole } from '../src/catalog.js';

const router = express.Router();
router.use(userCors);
router.use(requireFirebaseUid);
const asArray = (v) => Array.isArray(v) ? v : [];
const DEFAULTS = (email) => ({email, role:'user', profileName:'', profilePhone:'', requestStatus:'Active', adminMessage:'Welcome!', balance:0, purchaseHistory:[]});

router.post('/init', asyncHandler(async (req,res)=>{
  const ref=db().collection('users').doc(req.uid); const snap=await ref.get();
  if(!snap.exists) await ref.set(DEFAULTS(req.email),{merge:true});
  else if(req.email && snap.data().email!==req.email) await ref.set({email:req.email},{merge:true});
  res.json({success:true});
}));

router.get('/balance', asyncHandler(async (req,res)=>{
  const ref=db().collection('users').doc(req.uid); const snap=await ref.get();
  let data=snap.exists?(snap.data()||{}):DEFAULTS(req.email);
  if(!snap.exists) await ref.set(data,{merge:true});
  const rawBalance=Number(data.balance);
  const balance=Number.isFinite(rawBalance)?rawBalance:0;
  const topups=asArray(data.topupRequests);
  res.json({success:true,balance,adminMessage:String(data.adminMessage||''),requestStatus:String(data.requestStatus||'Active'),profileName:String(data.profileName||''),profilePhone:String(data.profilePhone||''),email:String(data.email||req.email||''),role:String(data.role||'user'),hasCompletedFirstTopup:topups.some(t=>t&&t.status==='APPROVED')});
}));

router.get('/catalog', asyncHandler(async (req,res)=>{
  const snap=await db().collection('users').doc(req.uid).get();
  const role=snap.exists?String((snap.data()||{}).role||'user'):'user';
  const catalog=catalogForRole(role==='reseller'?'reseller':'user');
  res.json({success:true,role,catalog:catalog&&typeof catalog==='object'?catalog:{}});
}));

router.post('/profile', asyncHandler(async(req,res)=>{const name=String(req.body?.name||'').trim(),phone=String(req.body?.phone||'').trim();if(!name||!phone)return res.status(400).json({success:false,error:'Please fill both fields'});if(name.length>60||phone.length>30)return res.status(400).json({success:false,error:'Name or phone is too long'});await db().collection('users').doc(req.uid).set({profileName:name,profilePhone:phone,name,whatsapp:phone,email:req.email},{merge:true});res.json({success:true});}));
router.get('/history', asyncHandler(async(req,res)=>{const snap=await db().collection('users').doc(req.uid).get();const purchases=snap.exists?asArray((snap.data()||{}).purchaseHistory):[];res.json({success:true,history:[...purchases].reverse()});}));
router.post('/history-clear',asyncHandler(async(req,res)=>{await db().collection('users').doc(req.uid).set({purchaseHistory:[]},{merge:true});res.json({success:true});}));
router.post('/topup',asyncHandler(async(req,res)=>{const amount=parseInt(req.body?.amount,10),esewaId=String(req.body?.esewaId||'').trim(),txCode=String(req.body?.txCode||'').trim().toUpperCase();if(!amount||amount<50)return res.status(400).json({success:false,error:'Enter a valid amount'});if(!esewaId||!txCode)return res.status(400).json({success:false,error:'eSewa ID and transaction code are required'});const ref=db().collection('users').doc(req.uid);try{const entry=await db().runTransaction(async tx=>{const snap=await tx.get(ref);const existing=snap.exists?asArray((snap.data()||{}).topupRequests):[];if(existing.some(t=>String(t?.txCode||'').toUpperCase()===txCode))throw new Error('This transaction ID was already submitted');const e={date:new Date().toISOString(),amount,esewaId,txCode,status:'PENDING',uid:req.uid,email:req.email};tx.set(ref,{topupRequests:[...existing,e]},{merge:true});return e;});res.json({success:true,request:entry});telegramNotify(telegramFormat('Top-up request',{username:req.email,email:req.email,product:`eSewa top-up (${esewaId})`,price:amount,uid:req.uid,status:'pending',others:`txCode: ${txCode}`}));}catch(e){res.status(409).json({success:false,error:e.message});}}));
router.get('/balance-history',asyncHandler(async(req,res)=>{const snap=await db().collection('users').doc(req.uid).get();const log=snap.exists?asArray((snap.data()||{}).adminLog):[];res.json({success:true,log:[...log].reverse()});}));
router.post('/report',asyncHandler(async(req,res)=>{const problem=String(req.body?.problem||'').trim();if(!problem)return res.status(400).json({success:false,error:'Please describe the problem'});if(problem.length>1000)return res.status(400).json({success:false,error:'Please keep it under 1000 characters'});const snap=await db().collection('users').doc(req.uid).get();const data=snap.exists?snap.data()||{}:{};telegramNotify(`🐛 <b>Problem Report</b>\n👤 ${esc(data.profileName||'—')}\n✉️ ${esc(data.email||req.email)}\n💰 Rs ${esc(data.balance??0)}\n🆔 <code>${esc(req.uid)}</code>\n📝 ${esc(problem)}`);res.json({success:true});}));
export default router;
