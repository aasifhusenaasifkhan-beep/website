const serverless = require("serverless-http");
const app = require("./api/index.js");

// Do not override module.exports with the app object to avoid AWS/Netlify HandlerNotFound errors
module.exports.handler = serverless(app);
