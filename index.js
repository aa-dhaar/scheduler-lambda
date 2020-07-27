const AWS = require("aws-sdk");
const initOptions = {/* initialization options */};
const pgp = require('pg-promise')(initOptions);
const validate = require('jsonschema').validate;

AWS.config.getCredentials(function(err) {
  if (err) console.error(err.stack);
  // credentials not loaded
  else {
    console.log("AWS Configured");
  }
});

// AWS bug that is not auto-updating region
AWS.config.update({region:'us-east-1'});

const lambda = new AWS.Lambda();
const secretManager = new AWS.SecretsManager();


/**
 * 
 * @param {} event Currently null or {}
 */
exports.handler = async (event) => {
    console.log('Executor Running', process.env);
    
    // Connect To Secret Manager & Database
    const data = await secretManager.getSecretValue({SecretId: 'arn:aws:secretsmanager:us-east-1:788726710547:secret:postgres-q03L8P'}).promise()
    
    secret = JSON.parse(data.SecretString);
    const cn = {
        host: process.env.PGHOST,
        port: process.env.PGPORT,
        database: process.env.PGDATABASE,
        user: process.env.PGUSER,
        password: secret.password,
        max: 1 
    };
    
    const db = pgp(cn);

    const scheduleObj = await db.oneOrNone(`SELECT jobs.ID as jobId,`
    +  ` jobs.STATE as jobState,`
    +  ` job.RETRY_COUNT as jobRetry,`
    +  ` job.AA_ID as userAA,`
    +  ` job.REQUEST_PARAMS as FIUpayload,`
    +  ` job.FUNCTION_ID as fnId,`
    +  ` functions.FUNCTION_NAME as fnName,`
    +  ` functions.STATE as fnState,`
    // +  ` functions.S3_LOCATION as fnLoc,`  // Don't need location in Scheduler Lambda
    +  ` functions.RESULT_JSON_SCHEMA as fnJsonSchema`
    +  ` FROM jobs`
    +      ` WHERE jobState='CREATED' AND (fnState='ACTIVE' OR fnState='INACTIVE')`
    +          ` INNER JOIN functions ON  functions.ID = jobs.FUNCTION_ID`
    +  ` ORDER BY jobs.CREATED DESC LIMIT 1`) 
    console.log(scheduleObj);

    // Return if no object in queue
    if (!scheduleObj) {
        return "Nothing in Queue";
    }

    const updateJob = async (newState, jobResult='') => {
        await db.none('UPDATE jobs SET STATE=$2, LAST_UPDATED = NOW(), RESULT=$3 WHERE ID = $1', [scheduleObj.jobId, newState, jobResult])
    }

    const increaseRetry = async (jobResult) => {
        if (scheduleObj.jobRetry >= +process.env.MAX_RETRIES)
            await db.none('UPDATE jobs SET STATE=$2, LAST_UPDATED = NOW(), RESULT=$3 , RETRY_COUNT=$4  WHERE ID = $1', [scheduleObj.jobId, 'FAILED', jobResult, scheduleObj.jobRetry+1])
        else
            await db.none('UPDATE jobs SET STATE=$2, LAST_UPDATED = NOW(), RESULT=$3 , RETRY_COUNT=$4  WHERE ID = $1', [scheduleObj.jobId, 'CREATED', jobResult, scheduleObj.jobRetry+1])

    }

    scheduleObj['fnQualifier'] = '$LATEST';

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
                await updateJob('PROCESSING');

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

                    //check for validation
                    if (validate(dataRun.Payload, JSON.parse(scheduleObj.fnJsonSchema))) {
                        result = {
                            data: dataRun.Payload,
                            log: dataRun.LogResult,
                            error: null
                        }
                    } else {
                        result = {
                            data: dataRun.Payload,
                            log: dataRun.LogResult,
                            error: 'Validation Failed'
                        }
                    }
                    
                } else {
                    // Function itself ran into an error
                    result = {
                        data: dataRun.Payload,
                        log: dataRun.LogResult,
                        error: dataRun.FunctionError
                    }
                }

                updateJob('SUCCESS', JSON.stringify(result))

            } catch (errRun) {
                // update: State -> Created & Retry++ (if r >= 3) set failed

                console.error('Function couldn\'t run. ', errRun.stack);
                result = {
                    data: null,
                    error: errRun.code,
                    logs: errRun.stack
                }
                increaseRetry(JSON.stringify(result))
            }
        } else {
            // Function is not yet created.
            console.error(`E4.1 Function not created for job ${scheduleObj.jobId}`)
            return "E4.1";
        }

    } catch (errFn) {
        console.error(`E4.2 Function pending creation for job ${scheduleObj.jobId}`);
        return "E4.2";
    }
    
    return result;
}
