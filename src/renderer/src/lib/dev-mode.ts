import { createContext, useContext } from 'react'

// Developer mode (Settings → Advanced → Developer mode): the chat shows how SahilBot works (the model behind
// each reply, its thinking, every step, tokens and cost). Off, it reads like a conversation: messages, the
// files and pictures it made, and the few actions that matter.

export const DevMode = createContext(false)

export const useDevMode = (): boolean => useContext(DevMode)

export const ModelDetails = createContext({ show: false, botChat: false })
export const useModelDetails = () => useContext(ModelDetails)
