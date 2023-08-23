"use strict";

const path = require("path");
const { JsonRpcProvider, EnsResolver, verifyMessage } = require("ethers");
const { NoDestError } = require("./error");
const { Address } = require("address-rfc2821");
const utils = require("haraka-utils");

let outbound;
let provider;

exports.register = function () {
  this.inherits("auth/auth_base");
  this.load_ensmail_ini();
  this.load_host_list();
  outbound = this.haraka_require("outbound");
};

exports.load_ensmail_ini = async function () {
  this.cfg = this.config.get("ens/ens.ini", () => {
    this.load_ensmail_ini();
  });

  if (!this.cfg.main.rpc_url) throw new Error("rpc url not given");
  provider = new JsonRpcProvider(this.cfg.main.rpc_url);

  this.mode = this.cfg.main.mode === "RECEIVE" ? "RECEIVE" : "FORWARD";

  // TODO: implement receive mode
  if (this.mode === "RECEIVE") {
    throw new Error("RECEIVE mode not implemented yet");
  }

  const haraka_dir = process.env.HARAKA || "";
  this.template_path =
    this.cfg.main.template_path ||
    path.resolve(haraka_dir, "./config/ens/templates/");
};

exports.load_host_list = function () {
  const lowered_list = {}; // assemble
  const raw_list = this.config.get("host_list", "list", () => {
    this.load_host_list();
  });

  for (const i in raw_list) {
    lowered_list[raw_list[i].toLowerCase()] = true;
  }

  this.host_list = lowered_list;
};

exports.hook_capabilities = function (next, connection) {
  // don't allow AUTH unless private IP or encrypted
  if (!connection.remote.is_private && !connection.tls.enabled) {
    connection.logdebug(this, "Auth disabled for insecure public connection");
    return next();
  }

  connection.capabilities.push(`AUTH PLAIN`);
  connection.notes.allowed_auth_methods = ["PLAIN"];

  next();
};

exports.hook_mail = async function (next, connection, params) {
  const sender = params[0];
  // is sender's host is this server, then it's outbound
  connection.transaction.notes.isOutbound = this.host_list[sender.host];

  if (
    connection.transaction.notes.isOutbound &&
    sender.user !== connection.notes.auth_user
  ) {
    return next(DENY, "not authenticated");
  }

  // TODO: maybe need some checks here
  next();
};

exports.hook_rcpt = async function (next, connection, params) {
  const txn = connection.transaction;
  if (!txn) return next();

  if (txn.notes.isOutbound) {
    return this.handle_send(next, connection, params);
  } else {
    return this.handle_forward(next, connection, params);
  }
};

exports.hook_data_post = function (next, connection) {
  const transaction = connection.transaction;

  if (!transaction.notes.isOutbound) {
    // rewrite sender
    /// make original sender be the reply-to
    this.loginfo(transaction.header.headers["from"]);
    transaction.add_header("Reply-to", transaction.header.headers["from"][0]);
    transaction.remove_header("From");
    transaction.add_header(
      "From",
      `Forwarder <${this.cfg.main.forwarder_address}>`
    );
    /// make sender be me
    transaction.mail_from = new Address(`<${this.cfg.main.forwarder_address}>`);
  }

  next();
};

exports.handle_send = async function (next, connection, params) {
  // TODO: Early rewrite if rcpt is also ens mail
  // for now, we skip rewrite and treat it as normal mail

  connection.relaying = true;
  next();
};

exports.handle_forward = async function (next, connection, params) {
  const transaction = connection.transaction;

  // TODO: should check if sender is friendly
  // for now, we assume senders are not spammer
  const address = params[0].address().toLowerCase();
  const host = params[0].address().split("@")?.[1].toLowerCase();
  if (!this.host_list[host]) {
    this.logdebug(`Not resolving because ${host} is not in host_list`);
    return next(DENY, `Not resolving because ${host} is not in host_list`);
  }

  // enable relaying to make it outbound
  connection.relaying = true;

  // rewrite recipient
  const dest = await this.lookup_ens_dest(address);
  connection.logdebug(this, `Resolved ${address} to ${dest}`);
  transaction.rcpt_to.pop();
  transaction.rcpt_to.push(new Address(`<${dest}>`));

  next();
};

exports.lookup_ens_dest = async function (mailAddress, depth = 0) {
  const ensName = mailAddress.split("@")[0] + ".eth"; // <address>@hostname => <address>.eth
  const ens = await EnsResolver.fromName(provider, ensName);

  // priority: 1. TXT MX record, 2. TEXT MAIL record
  const mxForwardTo = await ens.getText("mx.forwardTo");

  if (mxForwardTo) return mxForwardTo;

  const mxCanonical = await ens.getText("mx.canonical");
  if (mxCanonical) {
    if (depth > 10) throw new NoDestError("too many redirects");
    return this.lookup_ens_mx(mxCanonical, depth + 1);
  }

  const email = await ens.getText("email");
  if (email) return email;

  throw new NoDestError("no destination found");
};

exports.auth_plain = async function (next, connection, params) {
  // one parameter given on line, either:
  //    AUTH PLAIN <param> or
  //    AUTH PLAIN\n
  //...
  //    <param>
  if (params[0]) {
    const credentials = utils.unbase64(params[0]).split(/\0/);
    credentials.shift(); // Discard authid

    const [user, password] = credentials;
    let valid;
    try {
      const ens = await EnsResolver.fromName(provider, user + ".eth");
      const owner = await ens.getAddress();
      const verify = verifyMessage(
        `${this.cfg.main.sign_in_challenge}: ${user}`,
        password
      );
      valid = verify && verify === owner;
    } catch (err) {
      valid = false;
    }

    const statusCode = valid ? 235 : 535;
    const statusMessage = valid
      ? "2.7.0 Authentication successful"
      : "5.7.8 Authentication failed";

    if (valid) {
      connection.relaying = true;

      connection.respond(statusCode, statusMessage, () => {
        connection.authheader = "(authenticated bits=0)\n";
        connection.auth_results(`auth=pass (PLAIN)`);
        connection.notes.auth_user = credentials[0];
        return next(OK);
      });
      return;
    }

    if (!connection.notes.auth_fails) connection.notes.auth_fails = 0;

    connection.notes.auth_fails++;
    connection.results.add(
      { name: "auth" },
      {
        fail: `${this.name}/PLAIN`,
      }
    );

    let delay = Math.pow(2, connection.notes.auth_fails - 1);
    if (this.timeout && delay >= this.timeout) {
      delay = this.timeout - 1;
    }
    connection.lognotice(this, `delaying for ${delay} seconds`);
    // here we include the username, as shown in RFC 5451 example
    connection.auth_results(`auth=fail (PLAIN) smtp.auth=${credentials[0]}`);
    setTimeout(() => {
      connection.respond(statusCode, statusMessage, () => {
        connection.reset_transaction(() => next(OK));
      });
    }, delay * 1000);
  }

  if (connection.notes.auth_plain_asked_login) {
    return next(DENYDISCONNECT, "bad protocol");
  }

  connection.respond(334, " ", () => {
    connection.notes.auth_plain_asked_login = true;
    next(OK);
  });
};
