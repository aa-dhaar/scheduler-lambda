exports.handler = async (event) => {
    console.log(event);
    console.log(event.payload);
    return {
        "isHuman": false
    };
};
