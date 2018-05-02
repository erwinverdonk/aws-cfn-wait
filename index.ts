import * as HTTPS from 'https';
import * as URL from 'url';
import * as AWS from 'aws-sdk';

const uuid = require('uuid/v4');

type Callback = (error?:any, result?:any) => void;

type ResponseBody = {
  Status: string,
  Reason: string,
  PhysicalResourceId: string,
  StackId: string,
  RequestId: string,
  LogicalResourceId: string,
  Data?: string
}

type ResponseOptions = {
  hostname: string,
  port: number,
  path: string,
  method: string,
  headers: {[key:string]: string}
}

type Event = {
  ResponseURL: string,
  WaitProperties?: {
    httpsRequest: {
      options: ResponseOptions,
      responseBody: ResponseBody
    },
    responseData: any
  },
  ResourceProperties?: any,
  StackId: string,
  RequestId: string,
  LogicalResourceId: string,
  PhysicalResourceId?: string,
  RequestType: 'Create' | 'Update' | 'Delete'
}

type RequestTypeMethods = 'create'|'update'|'delete';

type CustomResourceConstructor = {
  create: (event:any, context:any) => Promise<CustomResourceInstance>
}

type CustomResourceInstance = {
  customResource: () => Promise<{
    [K in RequestTypeMethods]: () => Promise<any>
  }>,
  wait: (result:any) => Promise<{
    shouldWait: boolean,
    result?: any
  }>
};

type CreateParams = {
  CustomResource: CustomResourceConstructor, 
  waitDelay?:any, 
  event:any, 
  context:any, 
  callback: Callback
}

type ResultHandlerReturn = {
  canFinish: boolean,
  result?: any
}

export const AwsCfnWait = {
  /**
   * Instantiates the custom resource and the wait logic.
   */
  create: ({
    CustomResource, 
    waitDelay = 60000 /* default is 1 minute */, 
    event, 
    context, 
    callback
  }: CreateParams) => {
    /**
     * Initializes the instance with a valid event object.
     */
    const init =async (event: Event) => {
      type ResponseReceiver = ReturnType<typeof getResponseReceiver>;
  
      /**
       * The method 'finish' is called when the custom resource is completely
       * done with its tasks and is ready to call the response URL and exit.
       */
      const finish = (
        options:ResponseOptions, 
        responseBody:ResponseBody, 
        callback: Callback
      ) => (error?:any, data?:any) => {
        console.log('Finish');
        
        // Determine what to use as PhysicalResourceId for the custom resource.
        // When no PhysicalResourceId is provided in the data object, we use
        // the PhysicalResourceId from the event when available, the RequestId,
        // or a uuid.
        responseBody.PhysicalResourceId = (
          {...data}.PhysicalResourceId || 
          event.PhysicalResourceId || 
          event.RequestId ||
          responseBody.RequestId ||
          uuid()
        );
        responseBody.Data = error || data;
        responseBody.Status = error ? 'FAILED' : 'SUCCESS';
  
        const responseBodyStr = JSON.stringify(responseBody);
        options.headers['content-length'] = responseBodyStr.length.toString();
  
        console.log('HTTPS Response Request - Options', JSON.stringify(options));
        console.log('HTTPS Response Request - ResponseBody', responseBodyStr);
  
        // Finish the custom resource process by calling the response url.
        const request = HTTPS.request(
          options, 
          _ => _.on('data', _ => callback(null, _))
        );
        request.on('error', _ => callback(_, null));
        request.write(responseBodyStr);
        request.end();

        return responseBody;
      };
  
      /**
       * The method 'getResponseReceiver' is called to retrieve a response
       * receiver object, which contains methods to either call back (and wait) 
       * or finish the process.
       */
      const getResponseReceiver = (callback: Callback) => {
        // When there are no wait properties in the event object we build the 
        // responseBody and options objects here.
        if(!event.WaitProperties){
          const parsedUrl = URL.parse(event.ResponseURL);
          const responseBody:ResponseBody = {
            Status: undefined,
            Reason: `See the details in CloudWatch Log Stream: ${context.logStreamName}`,
            PhysicalResourceId: undefined,
            StackId: event.StackId,
            RequestId: event.RequestId,
            LogicalResourceId: event.LogicalResourceId,
            Data: undefined
          };
          const options:ResponseOptions = {
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
        // When there are wait properties we extract the responseBody and options
        // objects from there.
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
  
      /**
       * The method 'getResultHandler' is called to handle the result. It 
       * determines to wait, recursively call this function and callback or to 
       * finish the process.
       */
      const getResultHandler = (
        responseReceiver: ResponseReceiver, 
        customResource: CustomResourceInstance
      ) => (result:any):void => {
        if(result){
          console.log('success', JSON.stringify(result));
        }
  
        // When the custom resource request type is 'Delete' we do not proceed
        // to the wait logic but finish immediately.
        // TODO: See if this is needed or we can also wait for delete complete
        // if(event.RequestType === 'Delete'){
        //   responseReceiver.finish();
        //   return;
        // }
  
        // Decide whether to wait or finish the custom resource process.
        customResource.wait(result)
          .then(waitResult => {
            return new Promise((
              resolve:(data: ResultHandlerReturn) => void, 
              reject:(error: any) => void
            ) => {
              console.log('Wait result:', JSON.stringify(waitResult));
  
              // We should wait for the next recursion to decide whether the state
              // has become valid.
              if(waitResult.shouldWait){
                console.log('We are not yet done waiting, lets wait some more...')
                console.log(`Rechecking status in ${waitDelay} milliseconds`);
  
                // To not cause account wide Labda throttling, because of the 
                // unreserved concurrency limit, we throttle the recursive checking
                // here.
                setTimeout(() => {
                  const httpsRequest = responseReceiver.httpsRequest;
                  const currentEpoch = Math.ceil(new Date().getTime() / 1000);
                  const responseUrlExpires = parseInt(
                    httpsRequest.options.path.match(/(?<=&Expires=)\d+(?=&)/)[0],
                    16
                  );
  
                  // We compare the response url expire time with the current
                  // time + 5 minutes cq. Lambda maximum timeout, to determine
                  // whether we consider the custom resource timed out.
                  const hasExpired = responseUrlExpires <= currentEpoch+300
  
                  // The response URL has not expired yet, so retry.
                  if(!hasExpired){
                    const lambda = new AWS.Lambda();
                    lambda.invoke({
                      FunctionName: context.invokedFunctionArn,
                      InvocationType: 'Event',
                      Payload: JSON.stringify({
                        RequestType: event.RequestType,
                        ResourceProperties: event.ResourceProperties,
                        WaitProperties: event.WaitProperties || {
                          responseData: result,
                          httpsRequest
                        }
                      })
                    })
                    .promise()
                    .then(_ => resolve({canFinish: false, result: _}))
                    .catch(_ => reject(_));
                  } else {
                    reject({
                      message: 'Response URL has expired. Waiting canceled!'
                    });
                    
                  }
                }, waitDelay);
              } else {
                resolve({ canFinish: true, result: waitResult.result });
              }
            });
          })
          .then(_ => {
            if(_.canFinish){
              responseReceiver.finish(null, _.result);
            } else {
              responseReceiver.callback(null, _.result);
            }
          })
          .catch(_ => {
            responseReceiver.finish(_, null);
          });

          return result;
      };
  
      /**
       * The method 'getErrorHandler' is called to handle an error
       * result. It logs the error and finishes the process.
       */
      const getErrorHandler = (responseReceiver: ResponseReceiver) => (_:any) => {
        console.error('failed', JSON.stringify(_, Object.getOwnPropertyNames(_)));
        responseReceiver.finish({error: _}, null);

        return _;
      };
  
       // The response receiver object to use for both result and error handling.
      const responseReceiver = getResponseReceiver((error, result) => {
        if(result){
          console.log('success', JSON.stringify(result));
        }
  
        if(error){
          console.log('error', JSON.stringify(error));
        }
  
        callback(error, result);
      });
  
      console.log('event', JSON.stringify(event));
      console.log('context', JSON.stringify(context));
  
      // Instantiate the custom resource and determine whether to handle the 
      // request as a custom resource request typo or a wait call.
      const cr = await CustomResource.create(event, context);
      
      // Create result and error handler
      const resultHandler = getResultHandler(responseReceiver, cr);
      const errorHandler = getErrorHandler(responseReceiver);

      // Check whether we are in waiting state
      if(!event.WaitProperties){
        return cr.customResource()
          // Retrieve method matching request type
          .then(requestMethods => requestMethods[
            event.RequestType.toLowerCase() as RequestTypeMethods
          ])
          // Call the method
          .then(requestMethod => requestMethod())
          // Handle result
          .then(resultHandler)
          // Handle error
          .catch(errorHandler);
      } else {
        // Because we are in a waiting state, we can go to the result handler
        // immediately.
        resultHandler(event.WaitProperties.responseData);

        // Resolve with the result
        return Promise.resolve(event.WaitProperties.responseData)
      }
    };
  
    // In case of a wait call the event is a string and should be parsed.
    return init(typeof event === 'string' ? JSON.parse(event) : event);
  }
};