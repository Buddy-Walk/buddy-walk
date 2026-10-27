import { Camera, CameraType } from 'react-camera-pro';
import { useRef, useState, useEffect } from 'react';
import { Box, Stack, Switch, FormControlLabel, useMediaQuery, CircularProgress, Button } from '@mui/material';
import { useGeolocated } from 'react-geolocated';
import { sendTextRequest } from "../../api/question.ts";
// import {FirebaseStart} from "../../api/firebase.ts";
import { RequestData, CustomCoords } from "./types.ts";
import { AccessibleButton, AccessibleTypography, AccessibleTextField, BlueSection, GraySection, GreenSection } from "./style.ts";
import { createChatLog, addChatToChatLog } from "../../api/chatLog.ts";
import ReportMessage from '../../components/ReportMessage.tsx';
import { useDeviceOrientation } from '../../hooks/useDeviceOrientation.ts';
import CallAccessARideButton from "../../components/call.tsx"
import { createSpeechRecognitionPonyfill } from 'web-speech-cognitive-services';
import { getToken } from '../../api/token.ts';
import { playSound } from 'react-sounds';

export default function Test() {
    const camera = useRef<CameraType>(null);
    const isMobile = useMediaQuery('(max-width:600px)');
    const videoRef = useRef<HTMLVideoElement>(null);
    const [image, setImage] = useState<string | null>(null);
    const [videoBlob, setVideoBlob] = useState<Blob | null>(null);
    const [openAIResponse, setOpenAIResponse] = useState<string>('');
    const [loading, setLoading] = useState(false); //for the loading bar
    const responseRef = useRef<HTMLDivElement>(null); //to make the page scroll down when submit is clicked
    const [userInput, setUserInput] = useState<string>(''); //-----------------------------
    const [audioUrl, setAudioUrl] = useState("");
    const [currentChatId, setCurrentChatId] = useState("")
    const [currentMessageId, setCurrentMessageId] = useState("")
    const { coords } = useGeolocated({
        positionOptions: {
            enableHighAccuracy: true,
        },
        userDecisionTimeout: 5000,
        watchLocationPermissionChange: true
    });
    const [currentOrientation, setCurrentOrientation] = useState<{
        alpha: number | null,
        beta: number | null,
        gamma: number | null
    }>({ alpha: null, beta: null, gamma: null });
    const [cameraMode, setCameraMode] = useState<'photo' | 'video'>('photo');
    const [isRecording, setIsRecording] = useState(false);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const videoStreamRef = useRef<MediaStream | null>(null);
    const recognitionRef = useRef<SpeechRecognition | null | any>(null);
    const [isListening, setIsListening] = useState(false); // Track if voice button is active
    const { orientation, requestAccess } = useDeviceOrientation();
    const timeoutRef = useRef<number>();
    const HOLD_DELAY = 600;
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [lastError, setLastError] = useState<string>("");
    // const [showImage, setShowImage] = useState<boolean>(false)
    const headingRef = useRef<number>(0);

    useEffect(() => {
        (async function () {
            const azureToken = await getToken();
            if (azureToken && azureToken.token && azureToken.region) {
                const { SpeechRecognition } = createSpeechRecognitionPonyfill({
                    credentials: {
                        region: azureToken.region,
                        authorizationToken: azureToken.token,
                    }
                });
                const recognition = new SpeechRecognition();

                recognition.continuous = true;
                recognition.interimResults = false;
                recognition.lang = 'en-US';

                recognition.onstart = () => {
                    setIsListening(true);
                }
                recognition.onend = () => {
                    setIsListening(false);
                };
                recognition.onerror = (event) => console.error('Speech recognition error:', event.error);
                recognition.onresult = (event) => {
                    const lastResultIndex = event.results.length - 1;
                    const transcript = event.results[lastResultIndex]![0]!.transcript;
                    setUserInput(transcript);
                };

                recognitionRef.current = recognition;
            }
        })()
        return () => {
            if (recognitionRef.current) {
                recognitionRef.current.abort?.();
                recognitionRef.current = null;
            }
        };
    }, [])

    useEffect(()=> {
        if (isListening) {
            try{
                playSound('ui/item_select'); // Play sound when starting listening
            } catch (error) {
                console.error('Error playing sound:', error);
            }
        } else if (!isListening && recognitionRef.current) {
            try {
                playSound('ui/item_deselect'); // Play sound when stopping listening
            } catch (error) {
                console.error('Error playing sound:', error);
            }
        }
    }, [isListening])


    useEffect(() => {
        navigator.geolocation.getCurrentPosition(() => {}, (error) => {
            console.log(error.message);
        });
        requestAccess().then(() => {
            if (orientation)
                setCurrentOrientation({ alpha: orientation.alpha, beta: orientation.beta, gamma: orientation.gamma });
        })

        if (orientation) {
            setCurrentOrientation({ alpha: orientation.alpha, beta: orientation.beta, gamma: orientation.gamma });
        } else {
            setCurrentOrientation({ alpha: null, beta: null, gamma: null });
        }
        try {
            navigator.permissions.query({ name: 'camera' }).then(result => {
                if (result.state === 'prompt')
                    navigator.mediaDevices
                        .getUserMedia({ video: { facingMode: 'environment' } })
                        .then(stream => {
                            videoStreamRef.current = stream;
                            if (videoRef.current) {
                                videoRef.current.srcObject = stream;
                                videoRef.current.playsInline = true;
                                videoRef.current.muted = true;
                            }
                        })
                        .catch(console.error);
            })
        } catch (error) {
            console.error("Error accessing the camera:", error);
        }
        try {
            navigator.permissions.query({ name: 'microphone' }).then(result => {
                if (result.state === 'prompt') {
                    navigator.mediaDevices.getUserMedia({ audio: true }).catch(console.error);
                }
            });
        } catch (error) {
            console.error("Error accessing the mic:", error);
        }

        return () => {
            videoStreamRef.current?.getTracks().forEach(t => t.stop());
            videoStreamRef.current = null;
        };
    }, []);

    useEffect(() => {
        function handleDeviceOrientation(e: any) {
            if (typeof e.webkitCompassHeading === 'number') {
                headingRef.current = e.webkitCompassHeading;
            } else if (e.alpha !== null) {
                headingRef.current = e.alpha;
            }
        }
        window.addEventListener('deviceorientation', handleDeviceOrientation, false);
        return () => {
            window.removeEventListener('deviceorientation', handleDeviceOrientation, false);
        };
    }, []);

    useEffect(() => {
        (async function () {
            if (openAIResponse !== "") {
                // console.log(openAIResponse)
                speak(openAIResponse)
                setImage(null)
                setVideoBlob(null)
                try {
                    
                    if (currentChatId === "") {
                        // Use localStorage to get the name if it exists, otherwise do not include the name
                        // upload the image to firebase
                        // get the url back from firebase
                        // save the url in imageURL rather than the base64 image to save space
                        const res3 = localStorage.getItem('name') ? 
                            await createChatLog(
                                { user: localStorage.getItem('name') as string, messages: [
                                    { input: userInput, output: openAIResponse + lastError, imageURL: image as string, location: { lat: coords?.latitude as number, lon: coords?.longitude as number } }
                                ]}) : 
                            await createChatLog(
                                { messages: [{ input: userInput, output: openAIResponse + lastError, imageURL: image as string, location: { lat: coords?.latitude as number, lon: coords?.longitude as number } }] }
                            )
                        setLastError("")
                        console.log('chatLog', res3)
                        if (res3) {
                            setCurrentChatId(res3.data._id)
                            setCurrentMessageId(res3.data.messages[res3.data.messages.length - 1]._id)
                        }
                    } else {
                        const res3 = await addChatToChatLog({
                            id: currentChatId,
                            chat: { input: userInput, output: openAIResponse + lastError, imageURL: image as string, location: { lat: coords?.latitude as number, lon: coords?.longitude as number } }
                        })
                        setLastError("")
                        // console.log('chatLog', res3)
                        if (res3) {

                            setCurrentMessageId(res3.data.messages[res3.data.messages.length - 1]._id)
                        }
                    }
                } catch (error) {
                    console.error('Error creating chat log:', error);
                }
                setUserInput('')
                // console.log(currentMessageId)
            }
        })()

    }, [openAIResponse])
    // ----------------------------------------------------------------------------------------------------------------------

    function startVideoRecording() {
        setUserInput('Describe the video');
        try {
            if (videoStreamRef.current) {
                speechSynthesis.cancel(); // Stop TTS when loading ends
                speak("Capturing video")
                // Request rear camera access

                // console.log(videoStreamRef.current)
                const mimeType = MediaRecorder.isTypeSupported('video/mp4')
                    ? 'video/mp4'
                    : MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
                        ? 'video/webm;codecs=vp8'
                        : '';
                const mediaRecorder = new MediaRecorder(videoStreamRef.current, { mimeType });
                // "video/webm;mp4"
                // mp4 is needed for browser compatibility on mobile 
                mediaRecorderRef.current = mediaRecorder;

                const chunks: Blob[] = [];

                // Push recorded video data
                mediaRecorder.ondataavailable = (event) => {
                    if (event.data.size > 0) {
                        chunks.push(event.data);
                    }
                };

                // Handle stop recording
                mediaRecorder.onstop = () => {
                    let videoBlob = new Blob(chunks, { type: "video/mp4" });
                    if (videoBlob && videoBlob.size > 0) speak("Video captured.")
                    else speak("Video not captured. Please hold button for longer.")

                    setVideoBlob(videoBlob);
                    // console.log(navigator.vibrate(200))
                };

                mediaRecorder.start();
                setIsRecording(true);

                // Auto-stop after 5 seconds
                setTimeout(() => {
                    if (mediaRecorder.state === "recording") {
                        mediaRecorder.stop();
                        stopVideoStream();
                    }
                }, 5000); // 5 seconds
            }
        } catch (error) {
            speak("Could not capture the video.")
            console.error("Error accessing the camera:", error);
        }

    }
    function stopVideoRecording() {
        try {
            speechSynthesis.cancel(); // Stop TTS when loading ends
            mediaRecorderRef.current?.stop();
            stopVideoStream();
            setIsRecording(false);
        } catch (error) {
            speak("Could not stop the video.")
            console.error("Error accessing the camera:", error);
        }
    }
    const handleVideoRecording = async () => {
        if (!isRecording) {
            setUserInput('Describe the video');
            try {
                speak("Capturing video")
                // Request rear camera access
                const stream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: "environment" }, // Force rear camera
                });
                videoStreamRef.current = stream;

                const mediaRecorder = new MediaRecorder(stream, { mimeType: "video/mp4" });
                // "video/webm;mp4"
                // mp4 is needed for browser compatibility on mobile 
                mediaRecorderRef.current = mediaRecorder;

                const chunks: Blob[] = [];

                // Push recorded video data
                mediaRecorder.ondataavailable = (event) => {
                    if (event.data.size > 0) {
                        chunks.push(event.data);
                    }
                };

                // Handle stop recording
                mediaRecorder.onstop = async () => {
                    let videoBlob = new Blob(chunks, { type: "video/mp4" });
                    // console.log("Blob type before:", videoBlob.type);

                    // If on iOS Safari, convert WebM to MP4
                    // if (isIOS()) {
                    //   videoBlob = await convertWebMToMP4(videoBlob);
                    // }

                    setVideoBlob(videoBlob);
                    // console.log("Blob type after:", videoBlob.type);
                    // console.log("Video recorded:", URL.createObjectURL(videoBlob));
                };

                mediaRecorder.start();
                setIsRecording(true);

                // Auto-stop after 5 seconds
                setTimeout(() => {
                    if (mediaRecorder.state === "recording") {
                        mediaRecorder.stop();
                        stopVideoStream();
                        speak("Video captured.")
                    }
                }, 30000); // 30 seconds
            } catch (error) {
                speak("Could not capture the video.")
                console.error("Error accessing the camera:", error);
            }
        } else {
            // Stop manually if button is clicked again
            mediaRecorderRef.current?.stop();
            stopVideoStream();
            speak("Video captured.")
        }
    };

    // Stops the video stream
    const stopVideoStream = () => {
        // videoStreamRef.current?.getTracks().forEach((track) => track.stop());
        setIsRecording(false);
    };

    // -------------------------------------------------------------------------------------------------------------------

    const handleRetake = () => {
        setVideoBlob(null);
        setImage(null);
        URL.revokeObjectURL(audioUrl)
        setAudioUrl("")
        setOpenAIResponse("")
    };
    // -------------------------------------------------------------------------------------------------------------------

    const extractFrames = async (videoBlob: Blob): Promise<string[]> => {
        const videoUrl = URL.createObjectURL(videoBlob);
        const videoElement = document.createElement('video');
        videoElement.src = videoUrl;
        videoElement.setAttribute('playsinline', '');            // iOS inline hint :contentReference[oaicite:1]{index=1}
        videoElement.setAttribute('webkit-playsinline', 'true'); // older WebKit
        await videoElement.play();

        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) {
            throw new Error('Failed to get canvas context');
        }
        const frameInterval = 1; // Capture one frame per second
        const frames: string[] = [];

        return new Promise<string[]>((resolve) => {
            videoElement.addEventListener('timeupdate', () => {
                if (videoElement.currentTime < videoElement.duration) {
                    context.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
                    frames.push(canvas.toDataURL('image/jpeg'));
                    videoElement.currentTime += frameInterval;
                } else {
                    resolve(frames);
                }
            });
        });
    };
    // -------------------------------------------------------------------------------------------------------------------
    async function sendRequestOpenAI() {
        try {
            setLoading(true); //  loading starts
            speechSynthesis.cancel(); // Stop TTS when loading starts
            speak("loading response"); // Play TTS message
            // responseRef.current?.scrollIntoView({ behavior: 'smooth' }); // page scrolls down when loading starts

            let frames: string[] = [];
            // If videoBlob exists, extract all frames
            if (videoBlob) {
                frames = await extractFrames(videoBlob);
                //console.log('Extracted frames:', frames);
            }

            // Create the CustomCoords object
            const customCoords: CustomCoords | null = coords ? {
                latitude: coords.latitude,
                longitude: coords.longitude,
                accuracy: coords.accuracy,
                altitude: coords.altitude,
                altitudeAccuracy: coords.altitudeAccuracy,
                heading: headingRef.current,
                speed: coords.speed,
                orientation: orientation ? {
                    alpha: orientation.alpha !== null ? orientation.alpha : null,
                    beta: orientation.beta !== null ? orientation.beta : null,
                    gamma: orientation.gamma !== null ? orientation.gamma : null,
                } : null,
            } : null;

            //prepare the request data, including all extracted frames (if available)
            const data: RequestData = {
                text: userInput,
                image: frames.length > 0 ? frames : [image], //sends all frames, or fallback to a single image 
                // image: frames.length > 0 ? frames[0] : image, //only takes the first extracted frame or fallback to default image
                coords: customCoords,  // Use the CustomCoords object here
            };

            //console.log('Sending request data to backend:', data);
            const res = await sendTextRequest(data)
            // image to backend for firebase
            if (res) {
                //console.log('Received response from OpenAI:', res);
                setOpenAIResponse(res.output);
                // setUserInput('')
                //navigator.vibrate([100,100])
            }

        } catch (e) {
            console.error('Error sending request to OpenAI:', e);
            setLastError(e as string)
            setOpenAIResponse('An error occurred while processing your request. Please try again.');
        }
        finally {
            setLoading(false);
            speechSynthesis.cancel(); // Stop TTS when loading ends
        }
    }
    // -------------------------------------------------------------------------------------------------------------------
    //tts function for speaking
    function speak(text: string) {
        if ('speechSynthesis' in window) {
            const utterance = new SpeechSynthesisUtterance(text);
            speechSynthesis.speak(utterance);
            utterance.rate = 1; // Set the speech rate (optional)
        } else {
            console.error('Speech synthesis not supported in this browser.');
        }
    }
    // -------------------------------------------------------------------------------------------------------------------
    //speech to text- Speech recognition
    const startListening = () => {
        if (!isListening){ 
            
            if (!('webkitSpeechRecognition' in window)) {
                alert('Speech recognition is not supported in your browser.');
                return;
            }
           if(recognitionRef.current) recognitionRef.current.start();
        } else if(recognitionRef.current) recognitionRef.current.stop();
    };

    const stopListening = () => {

        if(recognitionRef.current && typeof recognitionRef.current.stop === 'function') recognitionRef.current.stop();
        setIsListening(false);
        // console.log(useSound('ui/item_deselect')); // Play sound when stopping listening
    };
    // -------------------------------------------------------------------------------------------------------------------
    const handleCapture = (target: EventTarget & HTMLInputElement) => {
        if (target.files) {
            if (target.files.length !== 0) {
                const file = target.files[0];

                if (file.type.startsWith("video")) {
                    setUserInput('Describe the video'); // Update prompt for video upload
                    //Blob URL for uploaded video
                    const videoBlob = new Blob([file], { type: file.type });
                    // const videoUrl = URL.createObjectURL(videoBlob);
                    //console.log("Video URL:", videoUrl);
                    setVideoBlob(videoBlob); // uploaded video is stored in BLOB same as recorded video
                } else {
                    const reader = new FileReader();
                    reader.onloadend = () => {
                        const img = new Image();
                        img.src = reader.result as string;
                        img.onload = () => {
                            const canvas = document.createElement("canvas");
                            const maxWidth = 640; // Max width for the image
                            const scaleSize = maxWidth / img.width;
                            canvas.width = maxWidth;
                            canvas.height = img.height * scaleSize;

                            const ctx = canvas.getContext("2d");
                            ctx!.drawImage(img, 0, 0, canvas.width, canvas.height);

                            // Convert the resized image to Base64
                            const compressedBase64 = canvas.toDataURL("image/jpeg", 0.7); // 0.7 = 70% quality
                            console.log(compressedBase64); // Use the compressed base64 string
                            setImage(compressedBase64);
                        };
                    };

                    if (file) {
                        reader.readAsDataURL(file);
                    }
                    // const newUrl = URL.createObjectURL(file);
                    // console.log(newUrl);
                }
            }
        }
    };

    function handlePointerDown(e: React.PointerEvent) {
        e.currentTarget.setPointerCapture(e.pointerId);
        timeoutRef.current = window.setTimeout(() => {
            startVideoRecording();
            timeoutRef.current = undefined;
        }, HOLD_DELAY);
    }

    function handlePointerUp(e: React.PointerEvent) {
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = undefined;
            // console.log(camera.current)
            try {
                // const capturedImage = camera.current?.takePhoto() as string;
                // if (capturedImage.length > 0) {
                //     // console.log("image captured ", capturedImage)
                //     setImage(capturedImage);
                //     speechSynthesis.cancel();
                //     speak("Image captured.")
                //     setUserInput('Describe the image');
                //     // navigator.vibrate(200)
                // }
                fileInputRef.current?.click();
                setUserInput('Describe the image');
                if (image) speak("Image Captured")
            } catch (error) {
                console.error('Failed to capture image. ', error);
                fileInputRef.current?.click();
                setUserInput('Describe the image');
                if (image) speak("Image Captured")
            }
            //console.log(orientation);

        } else {
            // otherwise we started recording → stop now
            stopVideoRecording();
        }
        e.currentTarget.releasePointerCapture(e.pointerId);
    }

    function tapToListen() {
        if(isListening){
            stopListening();
        } else {
            startListening();
        }
    }

    // -------------------------------------------------------------------------------------------------------------------
    return (

        <Stack
            component="main"
            role="main"
            sx={{
                display: 'flex', //flex container
                flexDirection: 'column',
                justifyContent: 'center', //centered horizontally
                alignItems: 'center', //centered vertically
                paddingLeft: isMobile ? '8px' : '32px',
                paddingRight: isMobile ? '8px' : '32px',
                backgroundColor: 'black',
                color: 'white',
                overflowX: 'hidden',
                overflowY: 'scroll',
                minHeight: '100vh', // Fill the entire viewport height.
                // paddingBottom: '100px',
            }}
        >
            {/* {showImage &&
            <Box  height="100vh" width="100vw" color="black">
                <img src={image as string} style={{width: "100%"}} />
                <AccessibleButton onClick={()=>setShowImage(false)}>
                    Close Photo Preview
                </AccessibleButton>
                
            </Box>
            } */}

            {/* Blue Section: Take Photo */}
            <BlueSection>
                {(!(videoBlob?.size && videoBlob?.size > 0) && !image) &&
                    <div style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',      // give it real layout size
                        height: '100%',     // or whatever aspect you need
                        opacity: 0,         // fully transparent
                        pointerEvents: 'none'
                    }}>
                        <Camera
                            aspectRatio={4 / 3}
                            facingMode={'environment'}
                            ref={camera}
                            aria-label="Camera viewfinder"
                            errorMessages={{}}
                        />
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/*"
                            capture="environment"
                            onChange={(e) => handleCapture(e.target)}
                            style={{ display: 'none' }}
                        />

                    </div>
                }
                <Box
                    sx={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',

                    }}
                >
                    <AccessibleTypography sx={{ alignSelf: "center", marginBottom: '1rem', fontSize: '2rem' }}>
                        {((videoBlob?.size && videoBlob?.size > 0) || image) ? (videoBlob?.size && videoBlob?.size > 0) ? "Video Captured": "Image Captured" : <>{"Tap for Photo"} <br /> {"Hold for Video"}</>}
                    </AccessibleTypography>
                </Box>
                {/* Condition for displaying either camera or video view depending on whether the image or videoBlob exists */}
                {!image && (!videoBlob || videoBlob.size == 0) ? (
                    <>
                        {/* Upload file button for desktop */}
                        {!isMobile && (
                            <>
                            <AccessibleButton
                                sx={{
                                    width: '100%',
                                    maxWidth: '600px',
                                    marginTop: '16px',
                                    marginBottom: '16px',
                                    '&:hover': { backgroundColor: '#303030', },
                                    '&:focus': {
                                        outline: '3px solid #FFA500',
                                        outlineOffset: '2px',
                                    },
                                }}
                                aria-label={image || videoBlob ? "Reupload file" : "Upload file"}
                                onClick={() => fileInputRef?.current?.click()}
                            >
                                {cameraMode === 'video' ? "UPLOAD VIDEO" : "UPLOAD IMAGE"}
                                
                            </AccessibleButton>
                            <input
                                ref={fileInputRef}
                                accept="image/*,video/*"
                                type="file"
                                capture="environment"
                                onChange={(e) => handleCapture(e.target)}
                                style={{ display: 'none' }}
                            />
                            </>
                        )}
                        {/* ----------------------------------------------------------------------------------------------------------- */}
                        {/* take picture/video buttons for mobile */}
                        {isMobile && (
                            <Box
                                sx={{
                                    display: 'flex',
                                    justifyContent: 'center',
                                    alignItems: 'center',
                                    gap: '16px', // space between buttons
                                    flexWrap: 'wrap',
                                }}
                            >

                                {/* Start/Stop Video Button */}
                                <Button
                                    component="label"
                                    sx={{
                                        display: 'flex',
                                        justifyContent: 'center',
                                        alignItems: 'center',
                                        padding: '20px',
                                        fontSize: '2rem',
                                        marginBottom: '2rem',
                                        backgroundColor: 'white',
                                        color: 'black',
                                        borderRadius: '20px',
                                        textAlign: 'center',
                                        cursor: 'pointer',
                                        fontWeight: 'bold',
                                        letterSpacing: '0.1em',
                                        height: '8rem',
                                        width: '90%',
                                        boxShadow: '2px 2px 10px rgba(0, 0, 0, 0.2)',
                                        '&:hover': {
                                            backgroundColor: '#e0e0e0',
                                        },
                                        '&:active': {
                                            backgroundColor: '#d0d0d0',
                                        },
                                    }}
                                    onPointerDown={handlePointerDown}
                                    onPointerUp={handlePointerUp}
                                    onPointerCancel={handlePointerUp}
                                    onPointerLeave={handlePointerUp}
                                    onPointerOut={handlePointerUp}
                                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click(); setUserInput('Describe the image'); } }}
                                    disabled={isRecording}
                                    aria-label="Tap for Picture, Hold for Video. Press Enter or Space to upload a photo."
                                >
                                    {isRecording ? "STOP VIDEO" : "CAMERA BUTTON"}
                                </Button>
                            </Box>
                        )}
                        {/* ----------------------------------------------------------------------------------------------------------- */}
                        {/* Take photo button (desktop)  */}
                        {!isMobile && cameraMode === 'photo' && (
                            <AccessibleButton
                                onClick={() => {
                                    const capturedImage = camera.current?.takePhoto() as string;
                                    if (capturedImage) {
                                        setImage(capturedImage);
                                        setUserInput('Describe the image');
                                    } else {
                                        console.error('Failed to capture image.');
                                    }
                                }}
                                aria-label="Take photo"
                                sx={{
                                    width: '100%',
                                    maxWidth: '600px',
                                    marginTop: '16px',
                                    marginBottom: '16px',
                                    '&:hover': { backgroundColor: '#303030', },
                                    '&:focus': {
                                        outline: '3px solid #FFA500',
                                        outlineOffset: '2px',
                                    },
                                }}
                            >
                                Take photo
                            </AccessibleButton>
                        )}
                        {/* ----------------------------------------------------------------------------------------------------------- */}
                        {/* Start/Stop Video button (desktop) */}
                        {!isMobile && cameraMode === 'video' && (
                            <AccessibleButton
                                onClick={handleVideoRecording}

                                aria-label={isRecording ? "Stop video" : "Start video"}
                                sx={{
                                    width: '100%',
                                    maxWidth: '600px',
                                    marginTop: '16px',
                                    marginBottom: '16px',
                                    '&:hover': {
                                        backgroundColor: '#e0e0e0',
                                    },
                                    '&:active': {
                                        backgroundColor: '#d0d0d0',
                                    },
                                }}
                            >
                                {isRecording ? "Stop Video" : "Start Video"}
                            </AccessibleButton>
                        )}
                    </>
                ) : (
                    <>
                        {/* <p>Buddy Walk</p> this text is a conditon that helps the video render */}
                        {/* Video Preview */}
                        
                        <Box sx={{ width: '100%', maxWidth: '600px', textAlign: 'center' }}>
                            {/* `<AccessibleButton
                                sx={{
                                    width: '100%',
                                    maxWidth: '600px',
                                    marginTop: '16px',
                                    marginBottom: '16px',
                                    '&:hover': { backgroundColor: '#303030', },
                                    '&:focus': {
                                        outline: '3px solid #FFA500',
                                        outlineOffset: '2px',
                                    },
                                }}
                                aria-label="View Captured Photo"
                                onClick={()=>setShowImage(true)}
                            >
                                View Captured Photo
                            </AccessibleButton>` */}
                            <AccessibleButton
                                onPointerUp={handleRetake}
                                aria-label="Retake photo or video"
                                sx={{
                                    width: '100%',
                                    maxWidth: '600px',
                                    marginTop: '16px',
                                    marginBottom: '16px',
                                    '&:hover': { backgroundColor: '#303030', },
                                    '&:focus': {
                                        outline: '3px solid #FFA500',
                                        outlineOffset: '2px',
                                    },
                                }}
                            >
                                Retake Photo
                            </AccessibleButton>
                        </Box>
                    </>
                )}
            </BlueSection>

            {/* --------------------------------------------------------------------------------------------------------- */}

            {/* Gray Section: Asking the Question */}
            <GraySection>
                {/* Question input field */}
                <Box
                    sx={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                    }}
                >
                    <AccessibleTypography>Enter A Question Below</AccessibleTypography>
                </Box>
                <AccessibleTextField
                    value={userInput}
                    onChange={(e) => setUserInput(e.target.value)}
                    sx={{ bgcolor: 'white', marginY: 2, maxWidth: '550px', borderRadius: '12px', width: '90%' }}
                    aria-label="Type Out Your Question Here"
                    // InputProps={{
                    //     endAdornment: (
                    //         <InputAdornment position="end">
                    //             <IconButton
                    //                 aria-label="clear text"
                    //                 onClick={() => setUserInput("")}
                    //                 edge="end"
                    //                 sx={{ visibility: userInput ? "visible" : "hidden" }}
                    //             >
                    //                 <ClearIcon />
                    //             </IconButton>
                    //         </InputAdornment>
                    //     ),
                    // }}
                />
                {/* speech to text button below */}
                <Button
                    // onPointerDown={(e) => startListening(e)}
                    // // onPointerDown={()=> SpeechRecognition.startListening}
                    // onPointerUp={(e) => stopListening(e)}
                    // // onPointerUp={() => {SpeechRecognition.stopListening(); console.log(transcript)}}
                    // // onTouchStart={startListening}
                    // // onTouchEnd={stopListening}
                    // onPointerCancel={stopListening} // Ensure it stops if finger is moved
                    // onPointerLeave={stopListening} // Stop if pointer leaves the button
                    aria-label="Tap to Ask a Question"
                    // onPointerOut={stopListening} // Stop if pointer is moved out
                    onClick={() => tapToListen()}
                    // onPointerCancel={() => SpeechRecognition.stopListening()}
                    style={{
                        padding: "12px 28px",          // shorter height and wider for tap comfort
                        borderRadius: "40px",          // rounder edges
                        cursor: "pointer",
                        color: "black",
                        fontSize: "1.2rem",
                        fontWeight: "800",
                        letterSpacing: "0.05em",
                        backgroundColor: "white",
                        boxShadow: "2px 2px 10px rgba(0, 0, 0, 0.2)",
                        display: "flex",
                        justifyContent: "center",
                        alignItems: "center",
                        width: "90%",          // allows it to size based on content
                        marginTop: "5px",
                        marginBottom: "16px",
                        border: "none",
                        minWidth: '50%', // minimum width for better touch target
                    }}
                >
                    {isListening ? 'Listening...' : 'Tap to Ask a Question'}
                </Button>
            </GraySection>

            {/* Green Section: Displaying the Response */}
            <GreenSection>
                {/* Submit button */}
                <AccessibleButton
                    onClick={() => sendRequestOpenAI()}
                    aria-label="Submit Question"
                    sx={{
                        display: 'flex',
                        justifyContent: 'center',
                        alignItems: 'center',
                        width: '90%',                 // full width
                        maxWidth: '600px',            // responsive cap
                        height: '80px',               // shorter than 120px but still chunky
                        padding: '20px',
                        fontSize: '2rem',
                        marginTop: '2rem',
                        marginBottom: '.5rem',
                        backgroundColor: 'white',
                        color: 'black',
                        borderRadius: '20px',
                        textAlign: 'center',
                        cursor: 'pointer',
                        fontWeight: 'bold',
                        letterSpacing: '0.1em',
                        boxShadow: '2px 2px 10px rgba(0, 0, 0, 0.2)',
                        '&:hover': {
                            backgroundColor: '#e0e0e0',
                        },
                        '&:active': {
                            backgroundColor: '#d0d0d0',
                        },
                    }}
                >
                    Submit
                </AccessibleButton>

                <div ref={responseRef} style={{ marginTop: '16px' }}> {/* to start the scroll down */}
                    {loading ? ( //loading circle
                        <Box
                            sx={{
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                margin: '20px',
                            }}
                        >
                            <CircularProgress
                                size={80}
                                thickness={6} //increased thickness for better visibility
                                sx={{
                                    margin: '20px',
                                    color: '#f8f8ff',

                                }}
                            />
                            <AccessibleTypography sx={{ color: '#f8f8ff', marginTop: '10px' }}>
                                Loading response...
                            </AccessibleTypography>
                        </Box>
                    ) : (
                        <Box aria-live="polite" role="status" sx={{ marginTop: 2, maxWidth: '600px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                            {openAIResponse != "" && 
                            <AccessibleButton
                                onClick={() => {
                                    if (speechSynthesis.speaking) speechSynthesis.cancel(); // Stop TTS if it's currently speaking
                                    else speak(openAIResponse); // Play TTS message
                                }}
                                aria-label="Play or Pause text-to-speech"
                                sx={{
                                    padding: "12px 28px",          // shorter height and wider for tap comfort
                                    borderRadius: "40px",          // rounder edges
                                    cursor: "pointer",
                                    color: "black",
                                    fontSize: "1.2rem",
                                    fontWeight: "700",
                                    letterSpacing: "0.05em",
                                    backgroundColor: "white",
                                    boxShadow: "2px 2px 10px rgba(0, 0, 0, 0.2)",
                                    display: "flex",
                                    justifyContent: "center",
                                    alignItems: "center",
                                    width: "fit-content",          // allows it to size based on content
                                    marginTop: "5px",
                                    marginBottom: "16px",
                                    border: "none",
                                }}
                            >
                                <span role="img" aria-label="Speaker Emoji" style={{ marginRight: '8px' }}>
                                    🔊
                                </span>
                                Play/Pause Response
                            </AccessibleButton>}
                            <AccessibleTypography>{openAIResponse}</AccessibleTypography>
                            {openAIResponse != "" && 
                            <AccessibleButton
                                onClick={()=> {navigator.clipboard.writeText(openAIResponse); speak("Response copied")}}
                                aria-label="Copy response to clipboard"
                            >
                                Copy Response
                            </AccessibleButton>
                            }
                            <ReportMessage openAIResponse={openAIResponse} currentMessageId={currentMessageId} currentChatId={currentChatId} />

                        </Box>
                    )}
                    
                    {/* code below adds the drag/seek audio bar */}
                    {/* {audioUrl && <audio id="ttsAudio" src={audioUrl} autoPlay style={{display:"none"}}/>}  */}
                    {/* --------------------------------------------------------------------------------------------- */}

                    {/*TTS Button with Play/Pause option*/}

                </div>
            </GreenSection>
            {/* Sticky Call Button */}
            <CallAccessARideButton />
            {/* Toggle switch for camera mode visible on desktop */}
            {!isMobile && (
                <FormControlLabel
                    control={
                        <Switch
                            checked={cameraMode === 'video'}
                            onChange={() => setCameraMode(cameraMode === 'photo' ? 'video' : 'photo')}
                        />
                    }
                    label={cameraMode === 'photo' ? 'Switch to Video' : 'Switch to Photo'}
                    aria-label="Toggle camera mode"
                    sx={{ width: '100%', maxWidth: '600px', marginTop: '16px' }}
                />
            )}
        </Stack>
    );
}