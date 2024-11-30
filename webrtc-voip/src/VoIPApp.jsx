import React, { useState, useEffect, useRef, useCallback } from 'react';

// Persistent Client ID Generation
const generateClientId = () => {
    let clientId = localStorage.getItem('voip-client-id');
    if (!clientId) {
        clientId = Math.random().toString(36).substr(2, 9);
        localStorage.setItem('voip-client-id', clientId);
    }
    return clientId;
};

// Utility function to serialize ICE candidate
const serializeIceCandidate = (candidate) => {
    if (!candidate) return null;
    return {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
        usernameFragment: candidate.usernameFragment
    };
};

// WebSocket Signaling Hook
const useWebSocket = (url) => {
    const [socket, setSocket] = useState(null);
    const [isConnected, setIsConnected] = useState(false);
    const [clientId] = useState(generateClientId());
    const broadcastChannel = useRef(new BroadcastChannel('voip-signaling'));

    const createWebSocket = useCallback(() => {
        const ws = new WebSocket(url);

        ws.onopen = () => {
            console.log('WebSocket Connected');
            ws.send(JSON.stringify({
                type: 'register',
                clientId: clientId
            }));
            setIsConnected(true);
            setSocket(ws);
        };

        ws.onclose = () => {
            console.log('WebSocket Disconnected');
            setIsConnected(false);
            setSocket(null);
            // Attempt reconnection
            setTimeout(createWebSocket, 3000);
        };

        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            setIsConnected(false);
        };

        return ws;
    }, [url, clientId]);

    useEffect(() => {
        const ws = createWebSocket();
        return () => ws.close();
    }, [createWebSocket]);

    const sendMessage = useCallback((message) => {
        if (socket && socket.readyState === WebSocket.OPEN) {
            const fullMessage = {
                ...message,
                from: clientId
            };
            socket.send(JSON.stringify(fullMessage));
            
            // Broadcast to other tabs
            broadcastChannel.current.postMessage(fullMessage);
        }
    }, [socket, clientId]);

    return { 
        socket, 
        isConnected, 
        sendMessage, 
        clientId,
        broadcastChannel: broadcastChannel.current 
    };
};

// WebRTC Connection Hook
const useWebRTC = (signaling) => {
    const [localStream, setLocalStream] = useState(null);
    const [remoteStream, setRemoteStream] = useState(null);
    const peerConnectionRef = useRef(null);
    const [connectionState, setConnectionState] = useState('new');

    const configuration = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    };

    const createPeerConnection = useCallback((targetClientId) => {
        // Close existing connection if it exists
        if (peerConnectionRef.current) {
            peerConnectionRef.current.close();
        }

        const pc = new RTCPeerConnection(configuration);

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                // Serialize the ICE candidate before sending
                signaling.sendMessage({
                    type: 'ice-candidate',
                    candidate: serializeIceCandidate(event.candidate),
                    target: targetClientId
                });
            }
        };

        pc.ontrack = (event) => {
            setRemoteStream(event.streams[0]);
            setConnectionState('connected');
        };

        pc.onconnectionstatechange = () => {
            setConnectionState(pc.connectionState);
        };

        peerConnectionRef.current = pc;
        return pc;
    }, [signaling, configuration]);

    const getLocalMedia = useCallback(async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true
            });
            setLocalStream(stream);
            return stream;
        } catch (error) {
            console.error('Error accessing media devices:', error);
            throw error;
        }
    }, []);

    const createOffer = useCallback(async (targetClientId) => {
        const pc = createPeerConnection(targetClientId);

        // Add local tracks
        if (localStream) {
            localStream.getTracks().forEach(track => {
                pc.addTrack(track, localStream);
            });
        }

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        
        return offer;
    }, [createPeerConnection, localStream]);

    const handleOffer = useCallback(async (offer, fromClientId) => {
        const pc = createPeerConnection(fromClientId);

        // Add local tracks
        if (localStream) {
            localStream.getTracks().forEach(track => {
                pc.addTrack(track, localStream);
            });
        }

        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        return answer;
    }, [createPeerConnection, localStream]);

    const addIceCandidate = useCallback(async (candidateData) => {
        if (peerConnectionRef.current && candidateData) {
            try {
                // Convert serialized candidate back to RTCIceCandidate
                const candidate = new RTCIceCandidate(candidateData);
                await peerConnectionRef.current.addIceCandidate(candidate);
            } catch (error) {
                console.error('Error adding ICE candidate:', error);
            }
        }
    }, []);

    return {
        localStream,
        remoteStream,
        connectionState,
        peerConnectionRef,
        getLocalMedia,
        createOffer,
        handleOffer,
        addIceCandidate
    };
};

// Main VoIP Application Component
const VoIPApp = () => {
    const { socket, isConnected, sendMessage, clientId, broadcastChannel } = useWebSocket('ws://voip-cpjv.onrender.com');
    const {
        localStream,
        remoteStream,
        connectionState,
        peerConnectionRef,
        getLocalMedia,
        createOffer,
        handleOffer,
        addIceCandidate
    } = useWebRTC({ sendMessage });

    const [callState, setCallState] = useState('idle');
    const [mediaReady, setMediaReady] = useState(false);
    const [targetClientId, setTargetClientId] = useState(null);

    // Cross-tab communication setup
    useEffect(() => {
        const handleBroadcastMessage = async (event) => {
            try {
                const message = event.data;

                // Ignore messages not meant for this client
                if (message.target && message.target !== clientId) return;

                switch (message.type) {
                    case 'register':
                        console.log('Registered client:', message.clientId);
                        break;

                    case 'offer':
                        setCallState('receiving');
                        setTargetClientId(message.from);
                        const answer = await handleOffer(message.offer, message.from);
                        sendMessage({ 
                            type: 'answer', 
                            answer, 
                            target: message.from 
                        });
                        break;
                    
                    case 'answer':
                        setCallState('connected');
                        await peerConnectionRef.current?.setRemoteDescription(
                            new RTCSessionDescription(message.answer)
                        );
                        break;
                    
                    case 'ice-candidate':
                        await addIceCandidate(message.candidate);
                        break;
                }
            } catch (error) {
                console.error('Error handling broadcast message:', error);
                setCallState('idle');
            }
        };

        // Direct WebSocket message handler
        const handleWebSocketMessage = async (event) => {
            try {
                const message = JSON.parse(event.data);
                handleBroadcastMessage({ data: message });
            } catch (error) {
                console.error('Error parsing WebSocket message:', error);
            }
        };

        // Add listeners
        broadcastChannel.addEventListener('message', handleBroadcastMessage);
        socket?.addEventListener('message', handleWebSocketMessage);

        // Cleanup
        return () => {
            broadcastChannel.removeEventListener('message', handleBroadcastMessage);
            socket?.removeEventListener('message', handleWebSocketMessage);
        };
    }, [
        socket, 
        broadcastChannel, 
        sendMessage, 
        handleOffer, 
        addIceCandidate, 
        peerConnectionRef, 
        clientId
    ]);

    // Initialize local media on component mount
    useEffect(() => {
        const initializeMedia = async () => {
            try {
                await getLocalMedia();
                setMediaReady(true);
            } catch (error) {
                console.error('Failed to get local media', error);
                setMediaReady(false);
            }
        };

        initializeMedia();
    }, [getLocalMedia]);

    // Initiate call
    const initiateCall = async () => {
        try {
            setCallState('calling');
            const offer = await createOffer(targetClientId);
            sendMessage({ 
                type: 'offer', 
                offer, 
                target: targetClientId 
            });
        } catch (error) {
            console.error('Call initiation failed:', error);
            setCallState('idle');
        }
    };

    // Determine if call button should be disabled
    const isCallButtonDisabled = 
        !isConnected ||  // Not connected to WebSocket
        !mediaReady ||   // Local media not initialized
        callState !== 'idle' ||  // Not in idle state
        !targetClientId;  // No target client selected

        return (
            <div className="voip-container">
                <div className="connection-info">
                    <div>My Client ID: {clientId}</div>
                    <div>Connection Status: {isConnected ? 'Connected' : 'Disconnected'}</div>
                    <div>Call State: {callState}</div>
                    <div>Connection State: {connectionState}</div>
                    <div>Media Ready: {mediaReady ? 'Yes' : 'No'}</div>
                </div>
        
                <div className="video-container" style={{
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    gap: '10px'
                }}>
                    <div 
                        className="local-video" 
                        style={{
                            position: 'relative',
                            border: '2px solid green',
                            padding: '10px',
                            width: '48%',
                            textAlign: 'center'
                        }}
                    >
                        <div 
                            style={{
                                position: 'absolute', 
                                top: '10px', 
                                left: '10px', 
                                backgroundColor: 'rgba(0,0,0,0.5)', 
                                color: 'white', 
                                padding: '5px',
                                borderRadius: '5px'
                            }}
                        >
                            Local Stream
                        </div>
                        <video
                            ref={(video) => {
                                if (video) video.srcObject = localStream;
                            }}
                            autoPlay
                            muted
                            playsInline
                            style={{
                                width: '100%',
                                maxHeight: '300px',
                                objectFit: 'cover',
                                transform: 'scaleX(-1)' // Mirror local video
                            }}
                        />
                        {!localStream && (
                            <div style={{
                                position: 'absolute',
                                top: '50%',
                                left: '50%',
                                transform: 'translate(-50%, -50%)',
                                color: 'red'
                            }}>
                                No Local Stream
                            </div>
                        )}
                    </div>
        
                    <div 
                        className="remote-video" 
                        style={{
                            position: 'relative',
                            border: '2px solid blue',
                            padding: '10px',
                            width: '48%',
                            textAlign: 'center'
                        }}
                    >
                        <div 
                            style={{
                                position: 'absolute', 
                                top: '10px', 
                                left: '10px', 
                                backgroundColor: 'rgba(0,0,0,0.5)', 
                                color: 'white', 
                                padding: '5px',
                                borderRadius: '5px'
                            }}
                        >
                            Remote Stream
                        </div>
                        <video
                            ref={(video) => {
                                if (video) video.srcObject = remoteStream;
                            }}
                            autoPlay
                            playsInline
                            style={{
                                width: '100%',
                                maxHeight: '300px',
                                objectFit: 'cover'
                            }}
                        />
                        {!remoteStream && (
                            <div style={{
                                position: 'absolute',
                                top: '50%',
                                left: '50%',
                                transform: 'translate(-50%, -50%)',
                                color: 'red'
                            }}>
                                Waiting for Remote Stream
                            </div>
                        )}
                    </div>
                </div>
        
                <div className="controls">
                    <input 
                        type="text" 
                        placeholder="Enter target Client ID"
                        value={targetClientId || ''}
                        onChange={(e) => setTargetClientId(e.target.value)}
                        style={{
                            padding: '10px',
                            width: '200px',
                            marginRight: '10px'
                        }}
                    />
                    <button 
                        onClick={initiateCall}
                        disabled={isCallButtonDisabled}
                        style={{
                            padding: '10px 20px',
                            backgroundColor: isCallButtonDisabled ? '#cccccc' : '#4CAF50',
                            color: 'white',
                            border: 'none',
                            cursor: isCallButtonDisabled ? 'not-allowed' : 'pointer'
                        }}
                    >
                        Start Call
                    </button>
                </div>
            </div>
        );
};

export default VoIPApp;