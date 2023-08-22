"use strict";

const path = require("path");
const { JsonRpcProvider, EnsResolver, EnsPlugin } = require("ethers");
const { NoDestError } = require("./error");
const { Address } = require("address-rfc2821");

let outbound;
let provider;

exports.register = function () {
  this.load_ensmail_ini();
  this.load_host_list();
  outbound = this.haraka_require("outbound");
};

exports.load_ensmail_ini = async function () {
  this.cfg = this.config.get("ens/ens.ini", () => {
    this.load_ensmail_ini();
  });

  if (!this.cfg.main.rpc_url) throw new Error("rpc url not given");
  provider = new JsonRpcProvider(this.cfg.main.rpc_url, {
    chainId: 11155111,
    ensAddress: "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e",
    ensNetwork: 11155111,
    name: "sepolia",
  });

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

exports.hook_mail = async function (next, connection, params) {
  // TODO: maybe need some checks here
  next();
};

exports.hook_rcpt = async function (next, connection, params) {
  const txn = connection.transaction;
  if (!txn) return next();

  // TODO: should check if sender is friendly
  // for now, we assume senders are not spammer
  const address = params[0].address().toLowerCase();
  const host = params[0].address().split("@")?.[1].toLowerCase();
  if (!this.host_list[host]) {
    this.logdebug(`Not resolving because ${host} is not in host_list`);
    return next(DENY, `Not resolving because ${host} is not in host_list`);
  }

  connection.relaying = true;
  const transaction = connection.transaction;

  // rewrite recipient
  const dest = await this.lookup_ens_dest(address);
  connection.logdebug(this, `Resolved ${address} to ${dest}`);
  transaction.rcpt_to.pop();
  transaction.rcpt_to.push(new Address(`<${dest}>`));

  next();
};

exports.hook_data_post = function (next, connection) {
  const transaction = connection.transaction;
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
