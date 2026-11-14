// Netlify Background Function (name ends with "-background": runs up to 15 minutes, responds 202 immediately).
// Drives agent runs in background mode; invoked by the API with an HMAC drive token.
import { handleNetlifyBackground } from "../../server/src/platform/netlify";

export default handleNetlifyBackground;
