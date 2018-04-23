"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const HTTPS = require("https");
const URL = require("url");
const AWS = require("aws-sdk");
exports.AwsCfnWait = {
    create: ({ CustomResource, waitDelay = 60000, event, context, callback }) => {
        const init = (event) => {
            const finish = (options, responseBody, callback) => (error, data) => {
                console.log('Finish');
                responseBody.PhysicalResourceId = (Object.assign({}, data).PhysicalResourceId ||
                    event.PhysicalResourceId ||
                    event.RequestId);
                responseBody.Data = error || data;
                responseBody.Status = error ? 'FAILED' : 'SUCCESS';
                const responseBodyStr = JSON.stringify(responseBody);
                options.headers['content-length'] = responseBodyStr.length.toString();
                console.log('HTTPS Response Request - Options', JSON.stringify(options));
                console.log('HTTPS Response Request - ResponseBody', responseBodyStr);
                const request = HTTPS.request(options, _ => _.on('data', _ => callback(null, _)));
                request.on('error', _ => callback(_, null));
                request.write(responseBodyStr);
                request.end();
            };
            const getResponseReceiver = (callback) => {
                if (!event.WaitProperties) {
                    const parsedUrl = URL.parse(event.ResponseURL);
                    const responseBody = {
                        Status: undefined,
                        Reason: `See the details in CloudWatch Log Stream: ${context.logStreamName}`,
                        PhysicalResourceId: undefined,
                        StackId: event.StackId,
                        RequestId: event.RequestId,
                        LogicalResourceId: event.LogicalResourceId,
                        Data: undefined
                    };
                    const options = {
                        hostname: parsedUrl.hostname,
                        port: 443,
                        path: parsedUrl.path,
                        method: 'PUT',
                        headers: {
                            'content-type': '',
                            'content-length': undefined
                        }
                    };
                    return {
                        callback,
                        finish: finish(options, responseBody, callback),
                        httpsRequest: {
                            options,
                            responseBody
                        }
                    };
                }
                else {
                    const httpsRequest = event.WaitProperties.httpsRequest;
                    const options = httpsRequest.options;
                    const responseBody = httpsRequest.responseBody;
                    return {
                        callback,
                        finish: finish(options, responseBody, callback),
                        httpsRequest: {
                            options,
                            responseBody
                        }
                    };
                }
            };
            const getResultHandler = (responseReceiver, customResource) => (result) => {
                if (result) {
                    console.log('success', JSON.stringify(result));
                }
                if (event.RequestType === 'Delete') {
                    return responseReceiver.finish();
                }
                return customResource.wait(result)
                    .then((_) => {
                    return new Promise((resolve, reject) => {
                        console.log('Wait result:', JSON.stringify(_));
                        if (_.shouldWait) {
                            console.log('We are not yet done waiting, lets wait some more...');
                            console.log(`Rechecking status in ${waitDelay} milliseconds`);
                            setTimeout(() => {
                                const httpsRequest = responseReceiver.httpsRequest;
                                const currentEpoch = Math.ceil(new Date().getTime() / 1000);
                                const responseUrlExpires = parseInt(httpsRequest.options.path.match(/(?<=&Expires=)\d+(?=&)/)[0], 16);
                                const hasExpired = responseUrlExpires <= currentEpoch + 300;
                                if (!hasExpired) {
                                    const lambda = new AWS.Lambda();
                                    lambda.invoke({
                                        FunctionName: context.invokedFunctionArn,
                                        InvocationType: 'Event',
                                        Payload: JSON.stringify({
                                            ResourceProperties: event.ResourceProperties,
                                            WaitProperties: event.WaitProperties || {
                                                responseData: result,
                                                httpsRequest
                                            }
                                        })
                                    })
                                        .promise()
                                        .then(_ => resolve({ canFinish: false, result: _ }))
                                        .catch(_ => reject({ canFinish: true, error: _ }));
                                }
                                else {
                                    reject({
                                        canFinish: true,
                                        error: {
                                            message: 'Response URL has expired. Waiting canceled!'
                                        }
                                    });
                                }
                            }, waitDelay);
                        }
                        else {
                            resolve({ canFinish: true, result: _.result });
                        }
                    });
                })
                    .then((_) => {
                    if (_.canFinish) {
                        responseReceiver.finish(null, _.result);
                    }
                    else {
                        responseReceiver.callback(null, _.result);
                    }
                })
                    .catch((_) => {
                    if (_.canFinish) {
                        responseReceiver.finish(_.error, null);
                    }
                    else {
                        responseReceiver.callback(_.error, null);
                    }
                });
            };
            const getErrorHandler = (responseReceiver) => (_) => {
                console.error('failed', JSON.stringify(_, Object.getOwnPropertyNames(_)));
                responseReceiver.callback({ error: _ }, null);
            };
            const responseReceiver = getResponseReceiver((error, result) => {
                if (result) {
                    console.log('success', JSON.stringify(result));
                }
                if (error) {
                    console.log('error', JSON.stringify(error));
                }
                callback(error, result);
            });
            console.log('event', JSON.stringify(event));
            console.log('context', JSON.stringify(context));
            CustomResource.create(event, context)
                .then((cr) => {
                if (!event.WaitProperties) {
                    cr.customResource()
                        .then((requestMethods) => requestMethods[event.RequestType.toLowerCase()])
                        .then((requestMethod) => requestMethod()
                        .then(getResultHandler(responseReceiver, cr))
                        .catch(getErrorHandler(responseReceiver)));
                }
                else {
                    getResultHandler(event.WaitProperties.responseData, cr);
                }
            });
        };
        init(typeof event === 'string' ? JSON.parse(event) : event);
    }
};
