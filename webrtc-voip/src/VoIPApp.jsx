import React, { useState, useEffect, useRef, useCallback } from 'react';

const generateClientId = () => {
    let clientId = localStorage.getItem('voip-client-id');
    if (!clientId) {
        clientId = Math.floor(1000 + Math.random() * 9000).toString();
        localStorage.setItem('voip-client-id', clientId);
    }
    return clientId;
};

const serializeIceCandidate = (candidate) => {
    if (!candidate) return null;
    return {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
        usernameFragment: candidate.usernameFragment
    };
};

const useWebSocket = (url) => {
    const [socket, setSocket] = useState(null);
    const [isConnected, setIsConnected] = useState(false);
    const [clientId] = useState(generateClientId());

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
        }
    }, [socket, clientId]);

    return { 
        socket, 
        isConnected, 
        sendMessage, 
        clientId 
    };
};

const useWebRTC = (signaling) => {
    const [localStream, setLocalStream] = useState(null);
    const [remoteStream, setRemoteStream] = useState(null);
    const peerConnectionRef = useRef(null);
    const [connectionState, setConnectionState] = useState('new');

    const configuration = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            // Consider adding TURN servers for better NAT traversal
            {
                urls: 'turn:openrelay.metered.ca:80',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            }
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
                console.log('Sending ICE candidate:', event.candidate);
                signaling.sendMessage({
                    type: 'ice-candidate',
                    candidate: serializeIceCandidate(event.candidate),
                    target: targetClientId,
                });
            }
        };

        pc.ontrack = (event) => {
            console.log('Remote stream received:', event.streams[0]);
            setRemoteStream(event.streams[0]);
            setConnectionState('connected');
        };
        
        pc.onconnectionstatechange = () => {
            console.log('Connection state:', pc.connectionState);
            setConnectionState(pc.connectionState);
        };

        peerConnectionRef.current = pc;
        return pc;
    }, [signaling, configuration]);

    const getLocalMedia = useCallback(async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { 
                    width: { ideal: 640 },
                    height: { ideal: 480 }
                },
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

        if (localStream) {
            localStream.getTracks().forEach((track) => {
                pc.addTrack(track, localStream);
            });
        } else {
            console.error('No local stream available.');
        }

        const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
        });
        await pc.setLocalDescription(offer);
        
        return offer;
    }, [createPeerConnection, localStream]);

    const handleOffer = useCallback(async (offer, fromClientId) => {
        const pc = createPeerConnection(fromClientId);

        if (localStream) {
            localStream.getTracks().forEach((track) => {
                pc.addTrack(track, localStream);
            });
        } else {
            console.error('No local stream available.');
        }

        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        return answer;
    }, [createPeerConnection, localStream]);

    const addIceCandidate = useCallback(async (candidateData) => {
        if (peerConnectionRef.current && candidateData) {
            try {
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

const VoIPApp = () => {
    const { socket, isConnected, sendMessage, clientId } = useWebSocket('wss://voip-cpjv.onrender.com');
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

    // WebSocket message handling
    useEffect(() => {
        const handleWebSocketMessage = async (event) => {
            try {
                const message = JSON.parse(event.data);

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
                console.error('Error handling WebSocket message:', error);
                setCallState('idle');
            }
        };

        // Add listener
        socket?.addEventListener('message', handleWebSocketMessage);

        // Cleanup
        return () => {
            socket?.removeEventListener('message', handleWebSocketMessage);
        };
    }, [
        socket, 
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

    const isCallButtonDisabled = 
        !isConnected ||
        !mediaReady ||
        callState !== 'idle' ||
        !targetClientId;

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