let detector;
self.onmessage=async({data})=>{
  try {
    if(data.type==='init') {
      // The Wasm loader needs importScripts, so this is a classic worker.
      const {FilesetResolver,PoseLandmarker}=await import('./vendor/mediapipe/vision_bundle.mjs');
      const vision=await FilesetResolver.forVisionTasks(new URL('./vendor/mediapipe/wasm',self.location.href).href);
      detector=await PoseLandmarker.createFromOptions(vision,{
        baseOptions:{modelAssetPath:new URL('./vendor/pose_landmarker_lite.task',self.location.href).href,delegate:'CPU'},
        runningMode:'VIDEO',numPoses:1,minPoseDetectionConfidence:.5,minPosePresenceConfidence:.5,minTrackingConfidence:.5,
        outputSegmentationMasks:false,
      });
      // Validate a real inference call without requesting or saving camera data.
      const testCanvas=new OffscreenCanvas(64,64);
      const testContext=testCanvas.getContext('2d');testContext.fillStyle='#888';testContext.fillRect(0,0,64,64);
      const testFrame=testCanvas.transferToImageBitmap();
      try{detector.detectForVideo(testFrame,1);}finally{testFrame.close();}
      self.postMessage({type:'ready'});
    } else if(data.type==='frame') {
      const start=performance.now();
      try {
        const result=detector.detectForVideo(data.frame,data.timestamp);
        self.postMessage({type:'pose',landmarks:result.landmarks[0]??null,worldLandmarks:result.worldLandmarks[0]??null,time:data.timestamp,ms:performance.now()-start,session:data.session});
      } finally { data.frame.close(); }
    }
  } catch(error) { self.postMessage({type:'error',message:error.message??String(error)}); }
};
