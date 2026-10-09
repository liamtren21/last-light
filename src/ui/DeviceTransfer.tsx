import {useState} from 'react';
import QRCode from 'qrcode';
import {api} from '../api/client';
import {recoveryLink} from './recovery-link';
export function DeviceTransfer({enabled}:{enabled:boolean}){
 const [link,setLink]=useState('');const [qr,setQr]=useState('');const [busy,setBusy]=useState(false);const [notice,setNotice]=useState('');
 async function create(){setBusy(true);setNotice('');setLink('');setQr('');try{
  const {code}=await api.createRecovery();const next=recoveryLink(code,location.origin);setLink(next);
  try{setQr(await QRCode.toDataURL(next,{width:240,margin:4,color:{dark:'#272b26',light:'#f5ecd7'}}));}catch{setNotice('The link is ready. The QR code could not be drawn.');}
 }catch{setNotice('Could not create a transfer link. Your current story is still saved. Try again.');}finally{setBusy(false);}}
 async function copy(){try{await navigator.clipboard.writeText(link);setNotice('Link copied. Open it on your other device.');}catch{setNotice('Select and copy the link below.');}}
 return <section className="journal-recovery" aria-label="Play on another device"><h2>Play on another device</h2><p className="journal-note">Open your private link on the other device, or scan the QR code. No name or long code to type.</p><button className="setting-row" disabled={!enabled||busy} onClick={()=>void create()}>{busy?'Preparing your link…':link?'Create a new link':'Create my private link'} <span>→</span></button>{!enabled&&<p>Cloud save is needed to transfer your story.</p>}{link&&<><button className="setting-row" onClick={()=>void copy()}>Copy link <span>→</span></button><label htmlFor="transfer-link">Your private link</label><input className="recovery-code transfer-link" id="transfer-link" value={link} readOnly onFocus={e=>e.currentTarget.select()}/>{qr&&<img className="transfer-qr" src={qr} alt="Scan to continue this crossing on another device"/>}<p className="journal-note">Keep this link private: anyone with it can open your story. It works once. Creating another replaces the previous link. Save it somewhere you can access on your other device.</p></>}<p role="status">{notice}</p></section>;
}
