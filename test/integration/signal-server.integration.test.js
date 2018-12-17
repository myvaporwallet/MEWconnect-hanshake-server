'use strict'

// Imports //
import _ from 'lodash'
import Peer from 'simple-peer'
import SocketIO from 'socket.io'
import SocketIOClient from 'socket.io-client'
import Redis from 'ioredis'
import wrtc from 'wrtc'

// Libs //
import CryptoUtils from '@utils/crypto-utils'
import { redisConfig, serverConfig, signals, stages, rtcSignals } from '@config'
import SignalServer from '@clients/signal-server'
import RedisClient from '@clients/redis-client'

describe('Signal Server', () => {
  // Instantiate SignalServer instance //
  const signalServer = new SignalServer()

  /**
   * Initialization tests involving the instantiation of SignalServer
   */
  describe('Initilization', () => {
    it('Should properly initialize', async () => {
      await signalServer.init()

      // HTTP Server //
      const serverAddress = signalServer.server.address()
      expect(typeof serverAddress).toBe('object')
      expect(serverAddress.address).toEqual(serverConfig.host)
      expect(serverAddress.port).toEqual(serverConfig.port)

      // Redis //
      expect(signalServer.redis instanceof RedisClient).toBe(true)
      const client = signalServer.redis.client
      expect(client instanceof Redis).toBe(true)
      expect(client.options.host).toEqual(redisConfig.host)
      expect(client.options.port).toEqual(redisConfig.port)

      // SocketIO //
      expect(signalServer.io instanceof SocketIO)
    })
  })

  /**
   * IO tests involving the socketIO connection of SignalServer.
   * Good reference: https://medium.com/@tozwierz/testing-socket-io-with-jest-on-backend-node-js-f71f7ec7010f
   */
  describe('IO', () => {
    // ===================== Test "Member Variables" ======================== //

    // Server/Socket Variables //
    let serverAddress
    let socketOptions = {
      'reconnection delay': 0,
      'reopen delay': 0,
      'force new connection': true,
      'connect timeout': 5000,
      transports: ['websocket', 'polling', 'flashsocket'],
      secure: true
    }

    // WebRTC Variables //
    const stunServers = [ { urls: 'stun:global.stun.twilio.com:3478?transport=udp' } ]
    const defaultWebRTCOptions = {
      trickle: false,
      iceTransportPolicy: 'relay',
      config: {
        iceServers: stunServers
      },
      wrtc: wrtc
    }

    // Key Variables //
    let publicKey
    let privateKey
    let connId
    let signed
    let version = '0.0.1'

    // Initiatior //
    let initiator = {
      socket: {},
      version: {},
      peer: {}
    }

    // Receiver //
    let receiver = {
      socket: {},
      version: {},
      peer: {},
      offer: {}
    }

    // ===================== Test "Member Functions" ======================== //

    /**
     * Connect to SignalServer and return the established socket connection
     * @param  {Object} options - Options to extend to merge with the "global" socketOptions
     * @return {Object} - Established socket connection with SignalServer
     */
    const connect = async (options = {}, namespace = '') => {
      let mergedOptions = _.merge(options, socketOptions)
      let socketManager = SocketIOClient(`${serverAddress}/${namespace}`, mergedOptions)
      let socket = await socketManager.connect()
      return socket
    }

    /**
     * Disconnect from a particular socket connection
     * @param  {Object} socket - An established socket connection with SignalServer
     */
    const disconnect = async (socket) => {
      if (socket.connected) await socket.disconnect()
    }

    // ===================== Test Initilization Processes ======================== //

    /**
     * Before all tests, get the SignalServer address and generate keys
     * used for communication.
     */
    beforeAll(async (done) => {
      // SigalServer Details //
      let address = signalServer.server.address()
      serverAddress = `http://${address.address}:${address.port}`

      // Keys / Connection Details //
      let keys = CryptoUtils.generateKeys()
      publicKey = keys.publicKey
      privateKey = keys.privateKey
      connId = CryptoUtils.generateConnId(publicKey)
      signed = CryptoUtils.signMessage(privateKey, privateKey)

      done()
    })

    /**
     * After all tests are completed, close socket connections.
     */
    afterAll(async (done) => {
      await disconnect(initiator.socket)
      await disconnect(receiver.socket)
      done()
    })

    // ===================== Initial Signaling Tests ======================== //

    describe('Initial Signaling', () => {
      describe('Initiator', () => {
        it('<IO>Should be able to initiate', async (done) => {
          let message = CryptoUtils.generateRandomMessage()
          let options = {
            query: {
              stage: stages.initiator,
              signed: signed,
              message: message,
              connId: connId
            }
          }
          initiator.socket = await connect(options)
          initiator.socket.on(signals.initiated, async (data) => {
            done()
          })
        })
      })

      describe('Receiver', () => {
        it('<IO>Should be able to initiate', async (done) => {
          let options = {
            query: {
              stage: stages.receiver,
              signed: signed,
              connId: connId
            }
          }
          receiver.socket = await connect(options)
          receiver.socket.on(signals.handshake, data => {
            expect(data).toHaveProperty('toSign')
            done()
          })
        })

        it('<IO>Should be able to sign', async (done) => {
          let versionObject = await CryptoUtils.encrypt(version, privateKey)
          receiver.socket.binary(false).emit(signals.signature, {
            signed: signed,
            connId: connId,
            version: versionObject
          })

          // Initiator socket will already have joined connId channel, listen for response //
          initiator.socket.on(signals.confirmation, data => {
            initiator.version = data.version
            expect(data).toHaveProperty('connId')
            expect(data).toHaveProperty('version')
            let expectedVersionProperties = ['ciphertext', 'ephemPublicKey', 'iv', 'mac']
            expect(Object.keys(data.version)).toEqual(expect.arrayContaining(expectedVersionProperties))
            done()
          })
        })
      })
    })

    // ===================== Offer Creation Tests ======================== //

    describe('Offer Creation', () => {
      describe('Initiator', () => {
        it('<WEB RTC>Should be able to send offer', async (done) => {
          // let plainTextVersion = await CryptoUtils.decrypt(initiator.version, privateKey)
          // let webRtcConfig = { servers: stunServers }

          // Add initiator property to default options //
          let webRTCOptions = {
            initiator: true,
            ...defaultWebRTCOptions
          }

          // Create WebRTC peer //
          initiator.peer = new Peer(webRTCOptions)
          initiator.peer.on(rtcSignals.signal, async (data) => {
            expect(data).toHaveProperty('type')
            expect(data).toHaveProperty('sdp')

            // Send WebRTC offer as encrypted string //
            let encryptedSend = await CryptoUtils.encrypt(JSON.stringify(data), privateKey)

            // Emit offer signal for receiver //
            initiator.socket.binary(false).emit(signals.offerSignal, {
              data: encryptedSend,
              connId: connId,
              options: stunServers
            })
          })

          // Receiver should receive offer signal //
          receiver.socket.on(signals.offer, async (data) => {
            let decryptedMessage = await CryptoUtils.decrypt(data.data, privateKey)
            receiver.offer = JSON.parse(decryptedMessage)
            done()
          })
        })
      })
      describe('Receiver', () => {
        it('<WEB RTC>Should be able to recieve offer', async (done) => {
          let expectedVersionProperties = ['type', 'sdp']
          expect(Object.keys(receiver.offer)).toEqual(expect.arrayContaining(expectedVersionProperties))

          done()
        })
      })
    })
  })
})
