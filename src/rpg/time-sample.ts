import { timeIncident } from './time-contracts.js';
/** A structured narrative hostage state; this fixture does not simulate hidden HP or combat. */
export function rescueClock(subject:string,storyEvent:string,choice='rescue'){
 return timeIncident.parse({id:'hostage-clock',title:'PRIVATE_HOSTAGE_CLOCK',truths:[{subject_id:subject,predicate:'hostage_condition',value:'safe'}],transitions:[
  {id:'injury',at_seconds:600,conditions:[],effects:[{subject_id:subject,predicate:'hostage_condition',expected:'safe',value:'injured'}]},
  {id:'loss',at_seconds:1200,conditions:[],effects:[{subject_id:subject,predicate:'hostage_condition',expected:'injured',value:'lost'}]}
 ],resolutions:[
  {story_event_id:storyEvent,choice_id:choice,conditions:[{type:'truth',subject_id:subject,predicate:'hostage_condition',value:'safe'}],effects:[{subject_id:subject,predicate:'hostage_condition',value:'rescued_safe'}],cancel_remaining:true},
  {story_event_id:storyEvent,choice_id:choice,conditions:[{type:'truth',subject_id:subject,predicate:'hostage_condition',value:'injured'}],effects:[{subject_id:subject,predicate:'hostage_condition',value:'rescued_injured'}],cancel_remaining:true}
 ]});
}
export function rescueStory(f:{enemy:string;hero:string;potion:string}){
 return {title:'시한이 있는 구조',rationale:'구조 시간과 실제 결과를 분리하고 관측으로 알게 한다.',threads:[{id:'rescue-thread',title:'구조 요청',goal:'인질을 구한다.',entity_ids:[f.enemy]}],events:[{id:'rescue-event',title:'구조 시도',description:'진입과 구조에는 GM이 제시한 시간이 걸린다.',category:'dilemma',thread_id:'rescue-thread',choices:[{id:'rescue',label:'구조를 시도한다',description:'활동 시간 견적을 수락하고 진입한다.',effects:[{type:'flag',key:'rescued',value:true},{type:'item',character_id:f.hero,item_id:f.potion,delta:1},{type:'thread',thread_id:'rescue-thread',status:'completed'}]},{id:'leave',label:'떠난다',description:'현재 구조를 유보한다.',effects:[{type:'flag',key:'left',value:true}]}]}]};
}
