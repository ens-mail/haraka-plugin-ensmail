class NoDestError extends Error {
  constructor(message) {
    super(message);
    this.name = "NoDistError";
  }
}

module.exports = {
  NoDestError,
};
