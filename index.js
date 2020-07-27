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
    console.log(event,cn);
    // TODO: Convert these to database fetch results

    const scheduleObj = {
        jobId: uuidv4(),
        fnName: 'fiu_ID',
        fnQualifier: '$LATEST',
        userAA: 'pikachu@aggregator',
        FIUpayload: {
            limits: {
                700: 'high',
                500: 'medium',
                300: 'low'
            }
        }
    };

    let result = {};
    try {
        const dataFn = await lambda.getFunction({
            FunctionName: scheduleObj.fnName,
            Qualifier: scheduleObj.fnQualifier,
        }).promise();
        const fnToRun = dataFn.Configuration;

        // https://docs.aws.amazon.com/lambda/latest/dg/API_FunctionConfiguration.html#SSS-Type-FunctionConfiguration-State
        if (fnToRun.State === 'Active' || fnToRun.State === 'Inactive') {
            try {
                // update: State -> Processing
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
                    // update: State -> Processed

                    //check for validation
                    result = {
                        data: dataRun.Payload,
                        log: dataRun.LogResult,
                        error: null
                    }
                } else {
                    // Function itself ran into an error
                    // update: State -> Processed

                    // TODO: Recheck it in docs

                    result = {
                        data: dataRun.Payload,
                        log: dataRun.LogResult,
                        error: dataRun.FunctionError
                    }
                }

            } catch (errRun) {
                // update: State -> Created & Retry++ (if r >= 3) set failed

                console.error('Function couldn\'t run. ', errRun.stack);
                result = {
                    data: null,
                    error: errRun.code,
                    logs: errRun.stack
                }
            }
        } else {
            // Function is not yet created.
            console.error(`E4.1 Function not created for job ${scheduleObj.jobId}`)
        }

    } catch (errFn) {
        console.error(`E4.2 Function pending creation for job ${scheduleObj.jobId}`)

        // update: State -> Creating

    }
    
    return result;
}
