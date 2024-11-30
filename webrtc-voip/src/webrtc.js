import React, { useState, useEffect, useRef, useCallback } from 'react';


const useWebRTC = (signaling) => {
    const [localStream, setLocalStream] = useState(null);
    const [remoteStream, setRemoteStream] = useState(null);
    const peerConnectionRef = useRef(null);

    const configuration = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    };

    const createPeerConnection = useCallback(() => {
        const pc = new RTCPeerConnection(configuration);

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                signaling.sendMessage({
                    type: 'ice-candidate',
                    candidate: event.candidate
                });
            }
        };

        pc.ontrack = (event) => {
            setRemoteStream(event.streams[0]);
        };

        return pc;
    }, [signaling]);

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
        }
    }, []);

    const createOffer = useCallback(async () => {
        if (!peerConnectionRef.current) {
            peerConnectionRef.current = createPeerConnection();
        }

        // Add local tracks
        if (localStream) {
            localStream.getTracks().forEach(track => {
                peerConnectionRef.current.addTrack(track, localStream);
            });
        }

        const offer = await peerConnectionRef.current.createOffer();
        await peerConnectionRef.current.setLocalDescription(offer);
        
        return offer;
    }, [createPeerConnection, localStream]);

    const handleOffer = useCallback(async (offer) => {
        if (!peerConnectionRef.current) {
            peerConnectionRef.current = createPeerConnection();
        }

        // Add local tracks
        if (localStream) {
            localStream.getTracks().forEach(track => {
                peerConnectionRef.current.addTrack(track, localStream);
            });
        }

        await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await peerConnectionRef.current.createAnswer();
        await peerConnectionRef.current.setLocalDescription(answer);
        
        return answer;
    }, [createPeerConnection, localStream]);

    const addIceCandidate = useCallback(async (candidate) => {
        if (peerConnectionRef.current && candidate) {
            try {
                await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (error) {
                console.error('Error adding ICE candidate:', error);
            }
        }
    }, []);

    return {
        localStream,
        remoteStream,
        getLocalMedia,
        createOffer,
        handleOffer,
        addIceCandidate
    };
};