// This code runs inside an SGX enclave.

var ROUND_TIME = 10 // seconds

function arraysEqual(array1, array2) {
    if (array1.byteLength !== array2.byteLength) {
      return false
    }

    var a1 = new Uint8Array(array1)
    var a2 = new Uint8Array(array2)

    for (var i = 0; i !== a1.length; i++) {
      if (a1[i] !== a2[i]) return false
    }

    return true
}

var timeSourceNonce = null

/**
 * Returns number of seconds relative to a reference point, as a number.
 */
function teeGetTrustedTime() {
  var trustedTime = SecureWorker.getTrustedTime()

  if (timeSourceNonce === null) {
    timeSourceNonce = trustedTime.timeSourceNonce
  }

  if (!arraysEqual(timeSourceNonce, trustedTime.timeSourceNonce)) {
    throw new Error("timeSourceNonce changed")
  }

  var currentTimeView = new DataView(trustedTime.currentTime)

  return currentTimeView.getUint32(0, true) + currentTimeView.getUint32(4, true) * Math.pow(2, 32)
}

var monotonicCounterId = null

// TODO: We should create all 256 monotonic counters and use them as one monotonic counter.
function teeIncrementMonotonicCounter() {
  if (monotonicCounterId === null) {
    var createdMonotonicCounter = SecureWorker.createMonotonicCounter()
    monotonicCounterId = createdMonotonicCounter.uuid
    return createdMonotonicCounter.value
  }
  else {
    return SecureWorker.incrementMonotonicCounter(monotonicCounterId)
  }
}

function teeReadMonotonicCounter() {
  if (monotonicCounterId === null) {
    throw new Error("Invalid state, monotonicCounterId")
  }

  return SecureWorker.readMonotonicCounter(monotonicCounterId)
}

/**
 * Returns a random value from [0, 1) interval.
 * Based on: http://stackoverflow.com/a/13694869/252025
 */
function teeGetRandom() {
  var array = new Uint32Array(2)
  crypto.getRandomValues(array)

  // Keep all 32 bits of the the first, top 20 of the second for 52 random bits.
  var mantissa = (array[0] * Math.pow(2, 20)) + (array[1] >>> 12)

  // Shift all 52 bits to the right of the decimal point.
  return mantissa * Math.pow(2, -52)
}

function teeReport(nonce) {
  return SecureWorker.getReport(nonce)
}

var counter = teeIncrementMonotonicCounter()
var roundBlockPayload = null
var roundTime = null
var sleepCallback = null

/**
 * Returns an IPFS CID of a given object, as a string.
 */
function ipfsAddress(object) {
  // TODO: Implement.
}

/**
 * Returns an IPFS CID of a given object, as an ArrayBuffer.
 */
function ipfsAddressArrayBuffer(object) {
  // TODO: Implement.
}

function f(l) {
  return (1 - l) * ROUND_TIME
}

/**
 * This function is a TEE method that sets the state of roundBlockPayload
 * and roundTime. The trusted time service teeGetTrustedTime() represents
 * a standard method provided as part of the TEE and is used as
 * verification for ROUND_TIME when mining a new block.
 */
function teeProofOfLuckRound(blockPayload) {
  if (sleepCallback !== null) {
    throw new Error("Invalid state, sleepCallback")
  }

  if (roundBlockPayload !== null || roundTime !== null) {
    throw new Error("Invalid state, roundBlockPayload or roundTime")
  }

  if (blockPayload === null) {
    throw new Error("Invalid blockPayload")
  }

  roundBlockPayload = blockPayload
  roundTime = teeGetTrustedTime()
}

/**
 * This function is a TEE method that uses the given new payload and
 * previous block and starts by checking the required ROUND_TIME has
 * elapsed before proceeding to generate a new luck value, using it
 * to compute an f(l) which determines the amount of time the TEE will
 * sleep. Upon return from sleeping f(l) duration, the function returns
 * a teeReport() that includes the luck value and payload hash.
 * Sleeping is implemented with help of another function,
 * teeProofOfLuckResumeFromSleep.
 */
function teeProofOfLuckMine(payload, previousBlock, previousBlockPayload) {
  if (sleepCallback !== null) {
    throw new Error("Invalid state, sleepCallback")
  }

  if (roundBlockPayload === null || roundTime === null) {
    throw new Error("Invalid state, roundBlockPayload or roundTime")
  }

  // The last link points to the parent block.
  var payloadParentLink = payload.Links[payload.Links.length - 1]
  if (payloadParentLink.name !== "parent" || payloadParentLink.hash !== ipfsAddress(previousBlock)) {
    throw new Error("payload.parent != hash(previousBlock)")
  }

  var previousBlockPayloadLink = previousBlock.Links[0]
  if (previousBlockPayloadLink.name !== "payload" || previousBlockPayloadLink.hash !== ipfsAddress(previousBlockPayload)) {
    throw new Error("previousBlock.payload != hash(previousBlockPayload)")
  }

  // The last link points to the parent block.
  var roundBlockPayloadParentLink = roundBlockPayload.Links[roundBlockPayload.Links.length - 1]
  var previousBlockPayloadParentLink = previousBlockPayload.Links[previousBlockPayload.Links.length - 1]
  if (previousBlockPayloadParentLink.name !== "parent" || roundBlockPayloadParentLink.name !== "parent" || previousBlockPayloadParentLink.hash !== roundBlockPayloadParentLink.hash) {
    throw new Error("previousBlockPayload.parent != roundBlockPayload.parent")
  }

  var now = teeGetTrustedTime()

  if (now < roundTime + ROUND_TIME) {
    throw new Error("now < roundTime + ROUND_TIME")
  }

  roundBlockPayload = null
  roundTime = null

  var l = teeGetRandom()
  var payloadAddress = new Uint8Array(ipfsAddressArrayBuffer(payload))

  var nonceBuffer = new ArrayBuffer(64)
  var nonceArray = new Uint8Array(nonceBuffer)
  var nonceView = new DataView(nonceBuffer)

  // Version.
  nonceView.setUint8(0, 1)
  // Luck.
  nonceView.setFloat64(1, l, true)
  // Size of payloadAddress.
  nonceView.setUint8(9, payloadAddress.byteLength)
  // payloadAddress.
  nonceArray.set(payloadAddress, 10)

  sleepCallback = function () {
    var newCounter = teeReadMonotonicCounter()
    if (counter !== newCounter) {
      throw new Error("counter !== newCounter")
    }

    return teeReport(nonceBuffer)
  }

  // Returns the time to sleep, in seconds.
  return f(l)
}

/**
 * A helper function to implement sleeping by returning to outside
 * of the enclave an then returning back in after sleeping time passed.
 */
function teeProofOfLuckResumeFromSleep() {
  // TODO: Verify that really sleeping time passed.

  if (sleepCallback === null) {
    throw new Error("Invalid state, sleepCallback")
  }

  if (roundBlockPayload !== null || roundTime !== null) {
    throw new Error("Invalid state, roundBlockPayload or roundTime")
  }

  var callback = sleepCallback
  sleepCallback = null

  return callback()
}