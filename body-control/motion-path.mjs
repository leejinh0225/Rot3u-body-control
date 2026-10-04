import {smoothPose} from './motion.mjs?v=continuity-11';
import {safePath,VIRTUAL_GEOMETRY} from './collision.mjs';

export function advanceMotion(body,virtual,target,dt){
  const nextBody=smoothPose(body,target,dt);
  const proposed=smoothPose(virtual,target,dt),check=safePath(virtual,proposed,VIRTUAL_GEOMETRY);
  // Preserve an independent, filtered human input even when the concept model
  // stops at its own collision boundary. Real output still needs guardedStep.
  return {body:nextBody,virtual:check.safe?proposed:virtual,virtualCollision:check.reason};
}
