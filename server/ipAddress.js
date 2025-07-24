const os = require("node:os");

const INTERFACE_FAMILIES = ["IPv4"];

module.exports = function() {
    return Object.values(os.networkInterfaces()).flat().filter(({family, internal}) => {
        return internal === false && INTERFACE_FAMILIES.includes(family);
    }).map(({ address }) => address);
};
