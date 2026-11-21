// The words that mean "make a video with HeyGen" (tools/video.ts): intent.ts loads the video tool for them and
// the router (llm/task-classifier.ts) treats them as agent work, so the tool is listed from the first step.

/** A request for a HeyGen-style video: an avatar or talking-head video, dubbing a video, an explainer, motion graphics. */
export const VIDEO_RE = /\b(heygen|hyperframes|higgsfield|invideo|vimeo|(cinematic|hyperrealistic|photorealistic) (video|clip|shot)s?|(build|make|create|produce) (me )?(an? |the |our |my )?video (about|for|of|on)|avatar videos?|talking[- ]head|ai (presenter|spokesperson|avatar)|spokesperson video|(dub|dubbing|dubbed)\b|lip[- ]?sync|translate (this|the|my|a|our) video|video translation|explainer videos?|motion[- ]graphics|animated (slides|explainer|video)|(make|create|generate|render) (me )?(an? |the |our |my )?(\d+[- ](second|sec|minute|min)[- ])?(promo |product |launch |marketing |training |onboarding )?video)\b/i
