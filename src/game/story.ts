import type { Scene, GameState, Choice } from './schema';
import {needsCooperation,cooperationComplete} from './cooperation';
const places = { ferry: 'NORTHSHORE FERRY SHELTER', tower: 'RIDGE ROAD · WATER TOWER', signal: 'COAST SIGNAL STATION' };
const scene = (id:string, chapter:number, title:string, background:Scene['background'], mira:string, rest:Partial<Scene> = {}):Scene => ({id,chapter,title,background,place:places[background],mira,expression:'attentive',choices:[],...rest});
const choice = (id:string,text:string,next:string,sets:string[]=[],rest:Partial<Choice>={}):Choice => ({id,text,next,sets,reply:'',...rest});
export const story:Record<string,Scene> = Object.fromEntries([
scene('ferry-first',1,'FIRST CONTACT','ferry','The last boat should have come through twenty minutes ago. I’m Mira. Are you waiting for the crossing too?',{choices:[
choice('ask-map','What does your map say?','ferry-map',['saw-map']),
choice('ask-weather','What changed out there?','ferry-weather'),
choice('share-name','I’m here to help get the signal back.','ferry-purpose')]}),
scene('ferry-map',1,'THE FOLDED MAP','ferry','This pencil line is the old service road. The water tower is here; the signal station sits beyond it. The printed tide line is years out of date.',{next:'ferry-board'}),
scene('ferry-weather',1,'A CHANGE IN THE WIND','ferry','The wind turned inland while we were waiting. See the foam against those steps? A boat could come through the harbor mouth without seeing how high the water is here.',{next:'ferry-board'}),
scene('ferry-purpose',1,'A LIGHT FOR THE COAST','ferry','The station warns boats away from the flooded landing. I know the path. I haven’t tried the equipment since last winter, and I could use another pair of eyes.',{next:'ferry-board'}),
scene('ferry-board',1,'THE WAITING LIST','ferry','The ferry clerk left a list: six passengers, all still waiting along the shore. I’ll copy it before we leave. If we have to turn back, we need to find all six.',{next:'ferry-plan'}),
scene('ferry-plan',1,'A WAY THROUGH','ferry','The ridge gives us a view of the water. The lower path has shelter from the wind. Which would you take? You can tell me your reason before we leave.',{choices:[
choice('ridge-route','Take the ridge. We’ll have a clear view.','ridge-lookout',['ridge-route'],{gives:['coast-map','passenger-list']}),
choice('low-route','Stay low. The wind will be rough up there.','low-waterline',['low-route'],{gives:['coast-map','passenger-list']})]}),
scene('ridge-lookout',1,'ABOVE THE LANDING','tower','From here I can see both channels. The outer one is still clear, but the landing steps are disappearing. We should mark this view on the map.',{choices:[
choice('mark-channel','Mark the clear outer channel.','ferry-rendezvous',['channel-observed']),
choice('mark-danger','Mark the flooded landing first.','ferry-rendezvous',['landing-observed'])]}),
scene('low-waterline',1,'THE WATERLINE','ferry','That dark mark on the wall was dry when we arrived. The lower path will close before dusk. There is still time to warn the people waiting further along it.',{choices:[
choice('warn-walkers','Tell the waiting passengers to move uphill.','ferry-rendezvous',['passengers-warned']),
choice('mark-water','Mark the waterline so we can check it again.','ferry-rendezvous',['waterline-marked'])]}),
scene('ferry-rendezvous',1,'BEFORE WE PART','ferry','I need to fetch the station key from the clerk’s box. You can check the landing while I do that. Where should we meet if the weather splits us up?',{choices:[
choice('promise-meet','Let’s meet back here if we get separated.','first-pause',['made-meeting-plan','survey-complete']),
choice('stay-in-sight','Let’s stay within sight of the shelter.','first-pause',['stay-in-sight','survey-complete'])]}),
scene('first-pause',1,'WAITING OUT THE SQUALL','ferry','The key is here. I’ll wrap the map before the rain gets to it. Take a moment under the roof; we’ll compare what we found when this squall passes.',{next:'chapter-two',checkpoint:true}),
scene('chapter-two',2,'THE RETURN','ferry','You’re back under the roof. The landing is worse now, and nobody has answered the radio. Before we move, tell me if your plan has changed.',{requires:['survey-complete'],choices:[
choice('try-tower','Let’s reach the signal room together.','tower-road',['chose-tower']),
choice('keep-promise','First check the route we marked.','route-review'),
choice('safe-return','The path is flooding. We should bring people back.','return-call',['return-chosen'])]}),
scene('route-review',2,'READING THE SHORE','ferry','The map gives us a route, but we still need to look at the ground. We can inspect the tower steps together and turn back if they have gone under.',{next:'tower-road'}),
scene('tower-road',2,'THE WATER TOWER','tower','No answer on the radio. Rain is crossing the path, and the station is just beyond the tower. There’s a handrail on the steps, but I can’t see its bottom fixing.',{choices:[
choice('inspect-steps','Check the handrail and the next few steps.','tower-inspection',['steps-inspected']),
choice('turn-back','The path is too slick. Let’s return together.','return-descent',['return-chosen'])]}),
scene('tower-inspection',2,'ONE STEP AT A TIME','tower','The rail holds. The top step is loose; keep your weight to the inside. I can open the station door from this side if you hold the torch.',{choices:[
choice('continue-together','We’ll go slowly. Stay close.','station-door',['station-reached'],{requires:['steps-inspected'],gives:['station-key']}),
choice('leave-steps','We’ve seen enough. Take the safe path back.','return-descent',['return-chosen'])]}),
scene('station-door',2,'THE STATION DOOR','tower','The key turns. Wait here while I push the door against the wind. There—leave your wet things by the entrance, clear of the wiring.',{next:'second-pause',requires:['station-reached']}),
scene('second-pause',2,'UNDER COVER','signal','We have a roof and a little daylight left. The lamp is dark. Before we touch the controller, we need to find out what still works.',{next:'signal-inspection',checkpoint:true}),
scene('signal-inspection',3,'THE LAST SIGNAL','signal','The battery gauge still moves. A notice says to check the cable and shutter before sending. Which will you inspect first?',{requires:['station-reached'],choices:[
choice('check-cable','Follow the cable to the lamp.','signal-cable',['cable-checked']),
choice('check-shutter','Check the shutter through the window.','signal-shutter',['shutter-checked'])]}),
scene('signal-cable',3,'THE WIRE','signal','The cable is seated and the insulation is dry. Now look through the window: I can move the shutter with this test handle. Does it clear the glass?',{next:'signal-tested'}),
scene('signal-shutter',3,'THROUGH THE WINDOW','signal','The shutter opens clear of the frame. I’ll follow the wire back to the controller. Both connections are seated, and there’s no water in the housing.',{next:'signal-tested'}),
scene('signal-tested',3,'ONE CHARGE','signal','Both checks are done. The battery has enough for one warning sequence. After that, we would have to wait for someone at the harbor to answer.',{choices:[
choice('arm-controller','Set the controller to the flood warning.','signal-room',['signal-inspected','warning-selected'])]}),
scene('signal-room',3,'THE LAST SIGNAL','signal','The flood warning is selected and the lamp is on standby. This lever sends it. We can warn the coast now, or keep the charge and carry the warning back ourselves.',{requires:['signal-inspected'],choices:[
choice('restore-signal','Send it now. They need the warning.','ending-signal',['ending-signal'],{requires:['signal-inspected','warning-selected']}),
choice('save-charge','Keep the charge. We’ll carry the warning back.','return-descent',['return-chosen','charge-preserved'])]}),
scene('return-descent',3,'BACK DOWN THE STEPS','tower','Keep one hand on the rail. I’ll call toward the lower path from here; the wind may carry a voice better than the radio. We still have the passenger list.',{next:'return-call'}),
scene('return-call',3,'CALLING PEOPLE IN','ferry','Two passengers are here. Four are further along the landing. We can call from the high steps or go in pairs along the sheltered wall.',{requires:['return-chosen'],choices:[
choice('call-from-steps','Call from the high steps and point out the route.','return-gather',['return-organized']),
choice('escort-pairs','Walk them back in pairs along the wall.','return-gather',['return-organized'])]}),
scene('return-gather',3,'SIX NAMES','ferry','They’re coming in now. I have five names crossed off. The last passenger is helping someone carry a case at the end of the wall. I’ll hold the gate open.',{next:'return-count'}),
scene('return-count',3,'EVERYONE UNDER THE ROOF','ferry','The last pair is through. Read the list with me before we close the gate; I don’t want to mistake a voice in the rain for someone safely inside.',{choices:[
choice('check-passengers','Check all six names against the people here.','return-confirmed',['passengers-accounted'],{requires:['return-organized']})]}),
scene('return-confirmed',3,'THE DRY SIDE OF THE DOOR','ferry','Six names, six passengers. The gate is shut. We can leave a warning for anyone arriving later and put the map where it will stay dry.',{next:'return-plan'}),
scene('return-plan',3,'FIRST LIGHT','ferry','The station will still be there in the morning. What should we do before we rest?',{choices:[
choice('leave-warning','Pin a flood warning beside the ferry board.','ending-return',['ending-return','warning-posted'],{requires:['passengers-accounted']}),
choice('keep-watch','Take the first watch by the gate.','ending-return',['ending-return','watch-arranged'],{requires:['passengers-accounted']})]}),
scene('ending-signal',3,'SIGNAL RESTORED','signal','Sending the warning now. Watch the harbor through the window. There—two flashes back. They’ve seen us. We can let go of the handle.',{requires:['ending-signal'],expression:'relieved',ending:'signal'}),
scene('ending-return',3,'SAFE RETURN','ferry','Everyone is under the roof. The map is dry. Listen—the wind is still rising, but there are voices in here now. We can try the station again at first light.',{requires:['ending-return','passengers-accounted'],expression:'relieved',ending:'return'})
].map(item=>[item.id,item]));
export const initialState=(options:{gameplayVersion?:2}={}):GameState=>({schemaVersion:2,...options,sceneId:'ferry-first',version:0,flags:[],history:[],unlockedChapters:[1],inventory:[],completedEndings:[]});
export function availableChoices(state:GameState):Choice[]{const allowed=[...(state.cooperation??[])].reverse().find(event=>event.sceneId===state.sceneId)?.allowedChoices;return (story[state.sceneId]?.choices??[]).filter(item=>(item.requires??[]).every(flag=>state.flags.includes(flag))&&(!needsCooperation(state)||cooperationComplete(state)&&!!allowed?.includes(item.id))).map(item=>state.gameplayVersion===2&&item.id==='promise-meet'?{...item,text:'Use our agreed meeting place if we get separated.'}:item);}
