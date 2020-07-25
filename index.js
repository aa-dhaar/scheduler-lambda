require('dotenv').config();



const AWS = require("aws-sdk");
const { v4: uuidv4 } = require('uuid');

AWS.config.getCredentials(function(err) {
  if (err) console.error(err.stack);
  // credentials not loaded
  else {
    console.log("AWS Configured");
  }
});
AWS.config.update({region:'us-east-1'});

const lambda = new AWS.Lambda();

/**
 * 
 * @param {} event Currently null or {}
 */
exports.handler = async (event) => {
    console.log(event);
    // TODO: Convert these to database fetch results

    const scheduleQueue = [{
        jobId: uuidv4(),
        fnName: 'arn:aws:lambda:us-east-1:788726710547:function:testFn',
        fnQualifier: '$LATEST',
        userAA: 'pikachu@aggregator',
        FIUpayload: {
            limits: {
                700: 'high',
                500: 'medium',
                300: 'low'
            }
        }
    }]

    const result = {};

    for (const scheduleObj of scheduleQueue) {
        try {
            const dataFn = await lambda.getFunction({
                FunctionName: scheduleObj.fnName,
                Qualifier: scheduleObj.fnQualifier,
            }).promise();
            const fnToRun = dataFn.Configuration;

            // https://docs.aws.amazon.com/lambda/latest/dg/API_FunctionConfiguration.html#SSS-Type-FunctionConfiguration-State
            if (fnToRun.State === 'Active' || fnToRun.State === 'Inactive') {
                try {
                    const dataRun = await lambda.invoke({
                        FunctionName: scheduleObj.fnName,
                        Qualifier: scheduleObj.fnQualifier,
                        // documentation bug https://github.com/aws/aws-sdk-js/issues/1876
                        Payload: JSON.stringify({
                            userAA: scheduleObj.userAA,
                            payload: scheduleObj.payload
                        }),
                    }).promise();
                    if (dataRun.StatusCode === 200) {
                        // Function ran successfully 🎉 
                        result[scheduleObj.jobId] = {
                            status: 'success',
                            data: JSON.parse(dataRun.Payload)
                        }
                    } else {
                        // Function itself ran into an error
                        result[scheduleObj.jobId] = {
                            status: 'failed',
                            data: JSON.parse(dataRun.Payload)
                        }
                    }

                } catch (errRun) {
                    console.error('Function couldn\'t run. ', errRun.stack);
                    result[scheduleObj.jobId] = {
                        status: 'failed',
                        error: errRun
                    };
                }
            } else {
                result[scheduleObj.jobId] = {
                    status: 'failed',
                    error: 'Function creation failed previously/is being created.'
                }
            }

        } catch (errFn) {
            result[scheduleObj.jobId] = {
                status: 'failed',
                error: 'Function does not exists'
            };
        }
    }
    
    return result;
}